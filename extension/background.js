/**
 * Orchestrates the agent loop: read sanitized screen state -> send to server
 * -> execute returned action -> repeat. Also drives the local face-detection
 * pass (visual redaction only, decoupled from the action loop).
 */
// Reuses redact.js as the single source of truth (same file the content
// script and the eval harness use) to verify the outgoing payload, rather
// than re-implementing PII patterns here.
importScripts("redact.js");

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787/agent/step";
const MAX_STEPS = 12;
const STEP_DELAY_MS = 400;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

function log(message) {
  chrome.runtime.sendMessage({ type: "log", message, ts: Date.now() }).catch(() => {});
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return resolve();
        if (tab.status === "complete") setTimeout(resolve, 150);
        else setTimeout(check, 150);
      });
    }
    check();
  });
}

async function readScreen(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["redact.js", "content_script.js"] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__agentReadScreen(),
  });
  return result;
}

async function executeAction(tabId, action) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (a) => window.__agentExecuteAction(a),
    args: [action],
  });
  return result;
}

function flashRedactText(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => window.__agentFlashRedactPageText && window.__agentFlashRedactPageText(),
    })
    .catch(() => {});
}

function flashRedactSensitiveFields(tabId, elements) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (els) => window.__agentFlashRedactSensitiveFields && window.__agentFlashRedactSensitiveFields(els),
      args: [elements],
    })
    .catch(() => {});
}

function clearFaceBlur(tabId) {
  return chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => document.querySelectorAll(".__agent-face-blur").forEach((n) => n.remove()),
    })
    .catch(() => {});
}

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_SCRAPING"],
      justification: "Runs a local face-detection model on a screenshot to redact faces before any network request.",
    });
  } catch (e) {
    // already exists — fine
  }
}

async function runFaceBlur(tabId, windowId, devicePixelRatio) {
  try {
    await ensureOffscreen();
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 }, (url) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(url);
      });
    });
    const resp = await chrome.runtime.sendMessage({ target: "offscreen", type: "detect-faces", dataUrl });
    if (!resp || resp.error) {
      log("face detection skipped: " + (resp && resp.error));
      return;
    }
    const dpr = devicePixelRatio || 1;
    const boxesCss = resp.boxes.map((b) => ({ x: b.x / dpr, y: b.y / dpr, w: b.w / dpr, h: b.h / dpr }));
    if (resp.boxes.length) {
      log(`local face detector: ${resp.boxes.length} face(s) found in ${resp.inferenceMs.toFixed(0)}ms (blurred on-screen, no pixels sent to server)`);
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (boxes) => window.__agentDrawFaceBlur && window.__agentDrawFaceBlur(boxes),
      args: [boxesCss],
    });
  } catch (e) {
    log("face detection error: " + e.message);
  }
}

function tallyByCategory(elements) {
  const tally = {};
  for (const el of elements) {
    if (el.sensitive) tally[el.sensitive] = (tally[el.sensitive] || 0) + 1;
  }
  return tally;
}

function formatTally(tally) {
  const entries = Object.entries(tally);
  return entries.length ? entries.map(([k, v]) => `${k}:${v}`).join(", ") : "none";
}

function logPrivacySummary(totals, bytesSent) {
  log(`privacy summary for this task: ${formatTally(totals)} redacted; ${bytesSent} bytes sent to the server across all steps, 0 raw PII bytes among them (verified before every send)`);
}

// Sent once per task, whichever way it ends (done, max steps, a refusal, or
// an error) - the side panel renders this into a persistent summary card
// instead of making the user scroll the log for the same numbers.
function sendTaskSummary(stats) {
  const elapsedMs = performance.now() - stats.startMs;
  const totalRedacted = Object.values(stats.privacyTotals).reduce((a, b) => a + b, 0);
  logPrivacySummary(stats.privacyTotals, stats.bytesSent);
  chrome.runtime
    .sendMessage({
      type: "summary",
      data: {
        elapsedMs,
        readMsTotal: stats.readMsTotal,
        totalRedacted,
        categories: stats.privacyTotals,
        actionsAttempted: stats.actionsAttempted,
        actionsSucceeded: stats.actionsSucceeded,
        bytesSent: stats.bytesSent,
      },
    })
    .catch(() => {});
}

async function callServer(serverUrl, task, screen, history) {
  const resp = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, screen, history }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`server ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function runTask(task, serverUrl) {
  if (!/\/agent\/step\/?$/.test(serverUrl)) {
    log(
      `Server URL looks wrong: "${serverUrl}" - expected it to end with /agent/step ` +
        `(the agent server, e.g. http://127.0.0.1:8787/agent/step), not the demo site itself. Fix it in the field above and try again.`
    );
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    log("no active tab");
    return;
  }
  const tabId = tab.id;
  const windowId = tab.windowId;
  const stats = {
    startMs: performance.now(),
    privacyTotals: {},
    bytesSent: 0,
    actionsAttempted: 0,
    actionsSucceeded: 0,
    readMsTotal: 0, // local DOM-read + redaction time only, summed across steps - excludes the Gemini round-trip
  };
  try {
    await runTaskLoop(tabId, windowId, task, serverUrl, stats);
  } finally {
    // Face-blur overlays have no auto-fade timer (unlike the two flash-redact
    // overlays below, which clear themselves after ~1.8s) - without this,
    // whatever was blurred on the last step stays stuck on the page forever
    // once the task stops calling runFaceBlur again. Runs on every exit path
    // (done, max steps, any guard/error return) since it's in `finally`.
    await clearFaceBlur(tabId);
    sendTaskSummary(stats);
  }
}

async function runTaskLoop(tabId, windowId, task, serverUrl, stats) {
  const history = [];
  let startUrl = null;
  const mentionsContinuation = /\b(then|after|afterwards|next|continue|and also)\b/i.test(task);
  // Deterministic guard against the LLM repeating a send/submit/post action:
  // a messaging/compose box normally clears itself after a successful send,
  // which can look to the model like "still needs filling in" rather than
  // "already done" - left unchecked, this can loop until MAX_STEPS repeatedly
  // re-sending the same message. Enforced in code, not just prompted against,
  // same principle as the sensitive-field refusal below.
  const taskAllowsSend = /\b(send|submit|post|publish|reply)\b/i.test(task);
  const SEND_LABEL_RE = /\b(send|submit|post|publish)\b/i;
  let sendCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    await waitForTabComplete(tabId);

    const t0 = performance.now();
    let screen;
    try {
      screen = await readScreen(tabId);
    } catch (e) {
      log("could not read page (is it a normal http(s) page?): " + e.message);
      return;
    }
    const readMs = performance.now() - t0;
    stats.readMsTotal += readMs;

    if (startUrl === null) {
      startUrl = screen.url;
    } else if (screen.url !== startUrl && !mentionsContinuation) {
      // Deterministic scope guard, independent of the LLM's own judgment:
      // the task named no further step, and we've already navigated once -
      // stop here rather than letting the model decide whether to keep going.
      log(
        `stopping: landed on a new page (${screen.url}) but the task didn't say to do anything ` +
          `there ("${task}"). Start a new task if you want it to continue on this page.`
      );
      return;
    }

    const tally = tallyByCategory(screen.elements);
    for (const [k, v] of Object.entries(tally)) stats.privacyTotals[k] = (stats.privacyTotals[k] || 0) + v;
    const nSensitive = screen.elements.filter((e) => e.sensitive).length;
    log(`step ${step + 1}: read ${screen.elements.length} elements (${nSensitive} redacted: ${formatTally(tally)}) on ${screen.url} in ${readMs.toFixed(0)}ms`);

    flashRedactText(tabId);
    flashRedactSensitiveFields(tabId, screen.elements); // covers form field values (card/password/phone/id), not just page text
    runFaceBlur(tabId, windowId, screen.devicePixelRatio); // fire-and-forget, visual only

    // Final gate before anything leaves the browser: re-scan the fully
    // serialized outgoing payload for raw PII patterns using the same rules
    // that produced the redacted labels above. Should always find zero by
    // construction (raw values are never collected into `screen` to begin
    // with) - this is the belt-and-suspenders proof, not the only defense.
    const outgoingPayload = JSON.stringify({ task, screen, history });
    const leakCheck = Redact.redactText(outgoingPayload);
    if (leakCheck.redactions.length) {
      log(
        `  LEAK CHECK FAILED: raw PII pattern(s) still present in the outgoing payload ` +
          `(${leakCheck.redactions.map((r) => `${r.type}:${r.count}`).join(", ")}) - aborting task, nothing sent.`
      );
      // Pinpoint the culprit without printing the leaked value itself -
      // idx/tag/role/sensitive-status (or which page-level field) is enough
      // to diagnose the structural cause without putting more PII in this
      // local log. Checks page-level fields too, not just element labels -
      // that's exactly what the title/url leak (fixed in content_script.js)
      // would otherwise have hidden from this diagnostic.
      if (Redact.redactText(screen.title || "").redactions.length) log("    culprit: screen.title");
      if (Redact.redactText(screen.url || "").redactions.length) log("    culprit: screen.url");
      for (const el of screen.elements) {
        if (Redact.redactText(el.label || "").redactions.length) {
          log(
            `    culprit: #${el.idx} <${el.tag}${el.type ? "[" + el.type + "]" : ""}>` +
              `${el.role ? " role=" + el.role : ""} sensitive=${el.sensitive || "null"} filled=${el.filled}`
          );
        }
      }
      return;
    }
    log(`  leak check: 0 raw PII patterns in outgoing payload (${outgoingPayload.length} bytes) - safe to send`);
    stats.bytesSent += outgoingPayload.length;

    const t1 = performance.now();
    let action;
    try {
      action = await callServer(serverUrl, task, screen, history);
    } catch (e) {
      log("server error: " + e.message);
      return;
    }
    const serverMs = performance.now() - t1;
    log(`  -> ${action.action}${action.target_idx ? " #" + action.target_idx : ""}${action.value ? ` "${action.value}"` : ""} — ${action.reasoning || ""} [${serverMs.toFixed(0)}ms]`);

    if (action.action === "done") {
      log("task complete");
      return;
    }

    if (action.action === "click") {
      const targetEl = screen.elements.find((e) => e.idx === action.target_idx);
      const looksLikeSend = targetEl && SEND_LABEL_RE.test(targetEl.label || "");
      if (looksLikeSend && !taskAllowsSend) {
        log(
          `  refused: task never asked to send/submit/post anything, but the agent tried to click ` +
            `"${targetEl.label}" (#${action.target_idx}) - stopping instead of sending.`
        );
        return;
      }
      if (looksLikeSend && sendCount >= 1) {
        log(
          `  refused: already sent/submitted once this task; agent tried to click "${targetEl.label}" ` +
            `(#${action.target_idx}) again - stopping to avoid a duplicate send.`
        );
        return;
      }
      if (looksLikeSend) sendCount++;
    }

    const result = await executeAction(tabId, action);
    stats.actionsAttempted++;
    if (result.ok) stats.actionsSucceeded++;
    if (!result.ok) log("  refused/error: " + result.error);
    else if (result.warning) log("  note: " + result.warning);
    history.push({ action, result });

    await new Promise((r) => setTimeout(r, STEP_DELAY_MS));
  }
  log("max steps reached, stopping");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "start-task") {
    runTask(msg.task, msg.serverUrl || DEFAULT_SERVER_URL);
  }
});
