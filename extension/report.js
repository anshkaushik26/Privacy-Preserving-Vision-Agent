// Full-report page. Nothing is stored anywhere: the latest task's steps are
// held in the open side panel's memory (popup.js) and requested from it by
// message, and new steps arrive as live broadcasts from background.js.
// Everything from the page is rendered with textContent / canvas - never
// innerHTML - because labels come from untrusted web pages.
(function () {
  const $ = (id) => document.getElementById(id);

  const isImage = (b) => b.sensitive === "image";
  const isPII = (b) => !!b.sensitive && b.sensitive !== "image";
  const hasArea = (b) => b.bbox && b.bbox.w > 0 && b.bbox.h > 0;

  const CATEGORY_NOTES = {
    "text-pii": "text-pii (PII found inside an element's visible text)",
    recipient: "recipient (someone else's address)",
  };

  const state = { meta: null, steps: [], selected: 1 };

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = src;
    });
  }

  // Draws the screenshot (or a blank page-sized canvas when there is none)
  // and returns the CSS-px -> canvas-px scale for element boxes.
  function baseCanvas(canvas, img, report) {
    const vw = (report.viewport && report.viewport.w) || 1280;
    const vh = (report.viewport && report.viewport.h) || 800;
    const ctx = canvas.getContext("2d");
    if (img) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      ctx.drawImage(img, 0, 0);
      return { ctx, sx: img.naturalWidth / vw, sy: img.naturalHeight / vh };
    }
    canvas.width = vw;
    canvas.height = vh;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, vw, vh);
    return { ctx, sx: 1, sy: 1 };
  }

  // Labels are sized against the canvas width (the canvas is shown scaled down
  // to fit its panel) and capped by the box height so they stay inside it.
  function boxLabel(ctx, text, x, y, w, h, color) {
    const size = Math.min(ctx.canvas.width / 36, h * 0.6);
    if (size < 9 || w < size * 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.font = `600 ${size}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + 5, y + h / 2);
    ctx.restore();
  }

  function paintAfter(canvas, img, report) {
    const { ctx, sx, sy } = baseCanvas(canvas, img, report);
    for (const b of report.boxes) {
      if (!hasArea(b) || (!isPII(b) && !isImage(b))) continue;
      const x = b.bbox.x * sx;
      const y = b.bbox.y * sy;
      const w = b.bbox.w * sx;
      const h = b.bbox.h * sy;
      if (isPII(b)) {
        ctx.fillStyle = "#000";
        ctx.fillRect(x, y, w, h);
        boxLabel(ctx, b.sensitive.toUpperCase(), x, y, w, h, "#fff");
      } else {
        ctx.fillStyle = "#4b5563";
        ctx.fillRect(x, y, w, h);
        boxLabel(ctx, "IMAGE", x, y, w, h, "#e5e7eb");
      }
    }
    for (const t of report.pageText || []) {
      const pad = 2;
      const x = t.bbox.x * sx - pad;
      const y = t.bbox.y * sy - pad;
      const w = t.bbox.w * sx + pad * 2;
      const h = t.bbox.h * sy + pad * 2;
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
      boxLabel(ctx, String(t.types[0] || "pii").toUpperCase(), x, y, w, h, "#fff");
    }
    for (const f of report.faces || []) {
      ctx.fillStyle = "#000";
      ctx.fillRect(f.x, f.y, f.w, f.h);
      boxLabel(ctx, "FACE", f.x, f.y, f.w, f.h, "#fbbf24");
    }
  }

  function paintOverlay(canvas, img, report) {
    const { ctx, sx, sy } = baseCanvas(canvas, img, report);
    const unit = Math.max(1, sx);
    for (const b of report.boxes) {
      if (!hasArea(b)) continue;
      const x = b.bbox.x * sx;
      const y = b.bbox.y * sy;
      const w = b.bbox.w * sx;
      const h = b.bbox.h * sy;
      ctx.setLineDash([]);
      if (isPII(b)) {
        ctx.fillStyle = "rgba(239,68,68,0.18)";
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 2 * unit;
      } else if (isImage(b)) {
        ctx.strokeStyle = "#9ca3af";
        ctx.lineWidth = 1.5 * unit;
        ctx.setLineDash([6 * unit, 4 * unit]);
      } else {
        ctx.strokeStyle = "#22c55e";
        ctx.lineWidth = 1.5 * unit;
      }
      ctx.strokeRect(x, y, w, h);
    }
    // sensitive text sitting in the page itself: found, but never read or sent
    ctx.lineWidth = 2 * unit;
    ctx.strokeStyle = "#ef4444";
    ctx.setLineDash([3 * unit, 3 * unit]);
    for (const t of report.pageText || []) {
      const pad = 2;
      const x = t.bbox.x * sx - pad;
      const y = t.bbox.y * sy - pad;
      const w = t.bbox.w * sx + pad * 2;
      const h = t.bbox.h * sy + pad * 2;
      ctx.fillStyle = "rgba(239,68,68,0.18)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "#f59e0b";
    for (const f of report.faces || []) ctx.strokeRect(f.x, f.y, f.w, f.h);
  }

  function foundCount(r) {
    return r.boxes.filter(isPII).length + (r.pageText || []).length;
  }

  function renderStats(report) {
    const pii = report.boxes.filter(isPII).length;
    const imgs = report.boxes.filter(isImage).length;
    const rawFound = report.leak.findings.reduce((a, f) => a + f.count, 0);
    const items = [
      ["PII fields redacted", pii],
      ["PII in page text", (report.pageText || []).length],
      ["Images → placeholder", imgs],
      ["Faces blurred", report.facesChecked ? (report.faces || []).length : "n/a"],
      ["Raw PII in payload", rawFound],
      ["Read + redact", Math.round(report.readMs) + " ms"],
      ["Payload size", report.payloadBytes != null ? (report.payloadBytes / 1024).toFixed(1) + " KB" : "—"],
    ];
    const host = $("stats");
    host.textContent = "";
    for (const [label, value] of items) {
      const card = document.createElement("div");
      card.className = "stat";
      const l = document.createElement("div");
      l.className = "label";
      l.textContent = label;
      const v = document.createElement("div");
      v.className = "value";
      v.textContent = String(value);
      card.append(l, v);
      host.appendChild(card);
    }
  }

  function renderSummary(report) {
    const ul = $("summary");
    ul.textContent = "";
    const add = (text) => {
      const li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    };
    const cats = {};
    for (const b of report.boxes) if (isPII(b)) cats[b.sensitive] = (cats[b.sensitive] || 0) + 1;
    const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    for (const [name, n] of entries) add(`${CATEGORY_NOTES[name] || name} × ${n}`);

    const textCats = {};
    for (const t of report.pageText || []) for (const type of new Set(t.types)) textCats[type] = (textCats[type] || 0) + 1;
    for (const [name, n] of Object.entries(textCats).sort((a, b) => b[1] - a[1])) {
      add(`${name} in page text × ${n} (not an element: never read, never sent)`);
    }
    if (!entries.length && !Object.keys(textCats).length) add("No sensitive fields or text found on this view");

    const imgs = report.boxes.filter(isImage).length;
    const safe = report.boxes.filter((b) => !b.sensitive).length;
    if (imgs) add(`image placeholders × ${imgs} (pixels never read or sent)`);
    add(`non-sensitive elements sent as structure × ${safe}`);
    if (report.facesChecked) add(`faces detected on-device × ${(report.faces || []).length}`);
  }

  function renderSteps() {
    const host = $("steps");
    host.textContent = "";
    const label = document.createElement("span");
    label.className = "muted";
    label.textContent = state.steps.length > 1 ? "Steps of this task:" : "This task ran 1 step:";
    host.appendChild(label);
    for (const s of state.steps) {
      const btn = document.createElement("button");
      btn.className = "stepbtn" + (s.step === state.selected ? " active" : "");
      btn.textContent = "Step " + s.step;
      const n = foundCount(s);
      if (n) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(n);
        badge.title = n + " sensitive item(s) found in this step";
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => {
        state.selected = s.step;
        renderSteps();
        renderSelected();
      });
      host.appendChild(btn);
    }
  }

  async function renderSelected() {
    const report = state.steps.find((s) => s.step === state.selected) || state.steps[0];
    if (!report) return;

    $("meta").textContent = `Step ${report.step} · ${report.url}${report.title ? ' · "' + report.title + '"' : ""} · captured ${new Date(
      report.capturedAt
    ).toLocaleString()}`;

    const gate = $("gate");
    if (report.leak.passed) {
      gate.className = "gate pass";
      gate.textContent = "PRIVACY GATE: PASS — 0 raw PII patterns in the payload before it was sent";
    } else {
      gate.className = "gate fail";
      gate.textContent =
        "PRIVACY GATE: FAIL — raw PII pattern(s) found (" +
        report.leak.findings.map((f) => f.type + ":" + f.count).join(", ") +
        "); payload withheld, nothing was sent";
    }

    renderStats(report);
    renderSummary(report);

    let img = null;
    if (report.screenshot) {
      try {
        img = await loadImage(report.screenshot);
      } catch (e) {
        img = null;
      }
    }
    const before = $("before");
    before.hidden = !img;
    $("beforeNote").hidden = !!img;
    if (img) before.src = report.screenshot;
    else before.removeAttribute("src");

    const after = $("after");
    after.hidden = !img;
    $("afterNote").hidden = !!img;
    if (img) paintAfter(after, img, report);

    paintOverlay($("overlay"), img, report);

    $("json").textContent = report.payload
      ? JSON.stringify(report.payload, null, 2)
      : "Withheld: the leak check failed, so this payload was neither sent nor stored.";
  }

  async function fetchFromPanel() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "report-get" });
      if (resp && Array.isArray(resp.steps)) return resp;
    } catch (e) {
      // no side panel open to answer
    }
    return null;
  }

  async function show() {
    const { meta, steps } = state;
    if (!steps.length) {
      $("empty").hidden = false;
      $("empty").textContent = meta
        ? "Task started — waiting for its first step to finish reading the page…"
        : "No report to show. Keep the side panel open, run a task there, then open this page from its View full report button.";
      $("content").hidden = true;
      $("source").textContent = meta ? "Task: " + meta.task : "";
      $("meta").textContent = "";
      return;
    }
    if (!steps.some((s) => s.step === state.selected)) state.selected = steps[0].step;
    $("empty").hidden = true;
    $("content").hidden = false;
    $("source").textContent = "Task: " + meta.task;
    renderSteps();
    await renderSelected();
  }

  async function init() {
    const resp = await fetchFromPanel();
    state.meta = resp ? resp.meta : null;
    state.steps = resp ? resp.steps : [];
    await show();
  }

  $("copy").addEventListener("click", async () => {
    const btn = $("copy");
    try {
      await navigator.clipboard.writeText($("json").textContent);
      btn.textContent = "Copied";
    } catch (e) {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });

  $("clear").addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "report-clear" });
    } catch (e) {}
    state.meta = null;
    state.steps = [];
    show();
  });

  // live updates while a task is running and this page is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "report-reset") {
      state.meta = { task: msg.task };
      state.steps = [];
      state.selected = 1;
      show();
    } else if (msg.type === "report-step" && msg.step) {
      const i = state.steps.findIndex((s) => s.step === msg.step.step);
      if (i >= 0) state.steps[i] = msg.step;
      else state.steps.push(msg.step);
      state.steps.sort((a, b) => a.step - b.step);
      if (!state.meta) state.meta = { task: "" };
      show();
    }
  });

  init();
})();
