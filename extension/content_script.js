/**
 * Injected on demand by background.js. Defines window.__agent* functions used
 * by the agent loop. Idempotent: safe to inject multiple times per page load.
 * Requires redact.js to be injected first (defines the global `Redact`).
 */
(function () {
  const SELECTOR =
    'input, textarea, select, button, a[href], [role="button"], [role="link"], [onclick], [contenteditable="true"], [role="textbox"]';

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent.trim()) return l.textContent.trim();
    }
    return null;
  }

  // Describes what a field IS (its label/placeholder) - deliberately never
  // falls back to el.value. A field's associated <label> (e.g. "Email")
  // would otherwise always win over its current value, so the model could
  // never tell an empty field from a filled one for anything with a <label>.
  function fieldDescription(el) {
    const raw =
      el.getAttribute("aria-label") ||
      labelFor(el) ||
      el.getAttribute("placeholder") ||
      (el.tagName === "BUTTON" || el.tagName === "A" ? el.innerText : null) ||
      el.textContent ||
      "";
    return raw.trim().slice(0, 120);
  }

  function describeElement(el, idx) {
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    el.setAttribute("data-agent-idx", String(idx));

    if (tag === "img") {
      el.removeAttribute("data-agent-sensitive");
      return {
        idx,
        tag,
        type: null,
        role: null,
        label: "[IMAGE]",
        sensitive: "image",
        filled: null,
        bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      };
    }

    const attrs = {
      type: el.type || null,
      autocomplete: el.getAttribute("autocomplete") || null,
      name: el.getAttribute("name") || null,
      readOnly: !!el.readOnly,
      label: fieldDescription(el),
      // An email field sharing a <form> with a password field reads as a
      // login/signup identifier (yours), not a message recipient (someone
      // else's) - see redact.js's classifyElementSensitivity for how this
      // is used. Structural, so it works regardless of the page's wording.
      looksLikeLoginField: !!(el.form && el.form.querySelector('input[type="password"]')),
    };

    let sensitive = Redact.classifyElementSensitivity(attrs);
    // A contenteditable node (e.g. Gmail's rich-text compose body) has no
    // .value at all - its current text lives in .textContent/.innerText instead.
    const isValueBearing = ["input", "textarea", "select"].includes(tag) || el.isContentEditable;
    const rawValue = isValueBearing ? (el.isContentEditable ? (el.innerText || "").trim() : String(el.value || "").trim()) : "";
    let label;

    if (sensitive) {
      label = `[${sensitive.toUpperCase()}]`;
    } else if (isValueBearing) {
      // Non-sensitive form field: show what it is AND its current value (or
      // that it's empty) - the model needs this to know whether its own
      // past "type" actions actually landed, and whether it's safe to move on.
      const desc = attrs.label || tag;
      if (rawValue) {
        if (attrs.type === "email") {
          // classifyElementSensitivity only lets an editable email field
          // through as non-sensitive when it's structurally a login/signup
          // field (shares a form with a password field) - every other email
          // field is already caught as "recipient" or "email" above, before
          // this branch. So reaching here means it's your own identifier for
          // a site you're actively signing into, not someone else's address.
          label = `${desc}: ${rawValue.slice(0, 120)}`;
        } else {
          const redacted = Redact.redactText(rawValue);
          label = `${desc}: ${redacted.text}`;
          if (redacted.redactions.length) sensitive = "text-pii";
        }
      } else {
        label = `${desc} (empty)`;
      }
    } else {
      const redacted = Redact.redactText(attrs.label);
      label = redacted.text;
      if (redacted.redactions.length) sensitive = "text-pii";
    }

    if (sensitive) el.setAttribute("data-agent-sensitive", sensitive);
    else el.removeAttribute("data-agent-sensitive");

    // Whether a sensitive field already has *some* value - never the value
    // itself - so the server can tell "user already filled this in" from
    // "still empty" without ever seeing what was typed.
    const filled = isValueBearing ? !!rawValue : null;

    return {
      idx,
      tag,
      type: attrs.type,
      role: el.getAttribute("role") || null,
      label,
      sensitive,
      filled,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
  }

  window.__agentReadScreen = function () {
    const map = new Map();
    window.__agentElementMap = map;

    let nodes = Array.from(document.querySelectorAll(SELECTOR + ", img")).filter(isVisible);
    // keep the innermost interactive element when one wraps another (e.g. <a><button/></a>)
    nodes = nodes.filter((el) => !nodes.some((other) => other !== el && el.contains(other)));

    const elements = nodes.map((el, i) => describeElement(el, i + 1));
    nodes.forEach((el, i) => window.__agentElementMap.set(i + 1, el));

    return {
      // Page-level metadata, not an element - never ran through
      // classifyElementSensitivity/redactText until now. A tab title can
      // embed the signed-in account's address (Gmail does this), so it needs
      // the same free-text redaction pass as any other page text.
      url: Redact.redactText(location.hostname + location.pathname).text,
      title: Redact.redactText(document.title).text,
      devicePixelRatio: window.devicePixelRatio || 1,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      elements,
    };
  };

  window.__agentExecuteAction = function (action) {
    if (action.action === "done") return { ok: true, done: true };

    if (action.action === "scroll" && !action.target_idx) {
      window.scrollBy(0, action.value ? Number(action.value) : 400);
      return { ok: true };
    }

    const map = window.__agentElementMap;
    if (!map) return { ok: false, error: "no element map; call read first" };
    const el = map.get(action.target_idx);
    if (!el) return { ok: false, error: `no element at idx ${action.target_idx}` };

    const sensitiveCategory = el.getAttribute("data-agent-sensitive");
    const typableException = action.action === "type" && sensitiveCategory && Redact.TYPABLE_SENSITIVE.has(sensitiveCategory);
    if (sensitiveCategory && !typableException) {
      return {
        ok: false,
        error: `refused: idx ${action.target_idx} is marked sensitive (${sensitiveCategory})`,
      };
    }

    if (action.action === "click") {
      el.click();
      // A click on a submit control can be silently swallowed by the
      // browser's own required-field validation (no error is thrown either
      // way) - surface that instead of reporting a plain, misleading "ok".
      if (el.form && !el.form.checkValidity()) {
        return {
          ok: true,
          warning: "click landed, but the form has empty/invalid required fields (likely sensitive ones only you can fill) so nothing was submitted",
        };
      }
      return { ok: true };
    }
    if (action.action === "type") {
      const text = action.value != null ? String(action.value) : "";
      if (el.isContentEditable) {
        // Rich-text editors (e.g. Gmail's compose body) ignore a raw
        // textContent assignment - they need real input events. execCommand
        // fires the beforeinput/input events these frameworks actually listen
        // for; fall back to a manual InputEvent if it's unavailable.
        el.focus();
        document.execCommand("selectAll", false, null);
        const inserted = document.execCommand && document.execCommand("insertText", false, text);
        if (!inserted) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
      } else {
        el.focus();
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { ok: true };
    }
    if (action.action === "scroll") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true };
    }
    return { ok: false, error: `unknown action ${action.action}` };
  };

  // --- Visual-only redaction demo: masks page text on screen. Independent of
  // the JSON payload above; never sends anything anywhere. ---
  window.__agentFlashRedactPageText = function () {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
      if (Redact.redactText(text).redactions.length > 0) hits.push(parent);
    }
    if (!hits.length) return { textNodesRedacted: 0 };
    if (!document.getElementById("__agent-redact-style")) {
      const style = document.createElement("style");
      style.id = "__agent-redact-style";
      style.textContent =
        ".__agent-redact-flash { background:#111 !important; color:#111 !important; border-radius:3px; transition: background 1.2s ease, color 1.2s ease; }";
      document.head.appendChild(style);
    }
    hits.forEach((el) => el.classList.add("__agent-redact-flash"));
    setTimeout(() => hits.forEach((el) => el.classList.remove("__agent-redact-flash")), 1800);
    return { textNodesRedacted: hits.length };
  };

  // Visual-only: briefly overlays every element already classified as
  // sensitive (password, card, phone, id, readonly email, free-text PII) -
  // not just loose page text. Covers form field *values*, which are never
  // text nodes and so are invisible to __agentFlashRedactPageText above.
  // pointer-events:none keeps fields clickable/typeable underneath.
  window.__agentFlashRedactSensitiveFields = function (elements) {
    const targets = (elements || []).filter((el) => el.sensitive && el.tag !== "img" && el.bbox.w > 0 && el.bbox.h > 0);
    if (!targets.length) return { fieldsRedacted: 0 };

    targets.forEach((el) => {
      const div = document.createElement("div");
      div.className = "__agent-sensitive-flash";
      Object.assign(div.style, {
        position: "fixed",
        left: el.bbox.x + "px",
        top: el.bbox.y + "px",
        width: el.bbox.w + "px",
        height: el.bbox.h + "px",
        background: "repeating-linear-gradient(45deg, #0d0d0d, #0d0d0d 6px, #1c1c1c 6px, #1c1c1c 12px)",
        borderRadius: "4px",
        zIndex: 2147483647,
        pointerEvents: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: "9px",
        fontFamily: "ui-monospace, monospace",
        letterSpacing: "0.5px",
        opacity: "0.96",
        transition: "opacity 0.8s ease",
      });
      div.textContent = el.sensitive.toUpperCase();
      document.body.appendChild(div);
      setTimeout(() => {
        div.style.opacity = "0";
        setTimeout(() => div.remove(), 800);
      }, 1000);
    });

    return { fieldsRedacted: targets.length };
  };

  // Draws blur overlays over detected face regions (CSS px, viewport-relative).
  window.__agentDrawFaceBlur = function (boxesCss) {
    document.querySelectorAll(".__agent-face-blur").forEach((n) => n.remove());
    boxesCss.forEach((b) => {
      const div = document.createElement("div");
      div.className = "__agent-face-blur";
      Object.assign(div.style, {
        position: "fixed",
        left: b.x + "px",
        top: b.y + "px",
        width: b.w + "px",
        height: b.h + "px",
        background: "rgba(10,10,10,0.92)",
        borderRadius: "6px",
        backdropFilter: "blur(12px)",
        zIndex: 2147483647,
        pointerEvents: "none",
      });
      document.body.appendChild(div);
    });
    return { facesBlurred: boxesCss.length };
  };
})();
