const logEl = document.getElementById("log");
const taskEl = document.getElementById("task");
const serverEl = document.getElementById("server-url");
const runBtn = document.getElementById("run");
const summaryEl = document.getElementById("summary");

chrome.storage.local.get(["serverUrl"], (r) => {
  if (r.serverUrl) serverEl.value = r.serverUrl;
});

function appendLine(text) {
  const div = document.createElement("div");
  div.className = "line";
  const t = new Date().toLocaleTimeString();
  div.textContent = `[${t}] ${text}`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderSummary(data) {
  summaryEl.classList.remove("empty");
  const seconds = (data.elapsedMs / 1000).toFixed(1);
  // Local DOM-read + redaction time only, summed across steps - excludes the
  // Gemini round-trip, so this is the part of Latency that's actually ours.
  const readMs = Math.round((data.readMsTotal || 0) * 10) / 10;
  const successRate = data.actionsAttempted > 0 ? `${data.actionsSucceeded}/${data.actionsAttempted}` : "—";
  summaryEl.innerHTML = `
    <div class="summary-stat"><div class="value">${seconds}s</div><div class="label">Latency</div></div>
    <div class="summary-stat"><div class="value">${readMs}ms</div><div class="label">Read+redact</div></div>
    <div class="summary-stat"><div class="value">${data.totalRedacted}</div><div class="label">Redacted</div></div>
    <div class="summary-stat"><div class="value">${successRate}</div><div class="label">Actions ok</div></div>
  `;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "log") appendLine(msg.message);
  if (msg.type === "summary") renderSummary(msg.data);
});

runBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
  summaryEl.className = "empty";
  summaryEl.textContent = "running…";
  const task = taskEl.value.trim();
  const serverUrl = serverEl.value.trim();
  if (!task) return;
  chrome.storage.local.set({ serverUrl });
  appendLine("starting task…");
  chrome.runtime.sendMessage({ type: "start-task", task, serverUrl });
});
