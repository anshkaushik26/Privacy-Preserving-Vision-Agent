# Privacy-Preserving Vision Agent

A browser agent that reads the screen and detects faces **locally**, redacts
PII before any network request, sends only a sanitized description of the
page to a server-side LLM (Gemini), and executes the action it returns. The
server never sees a password, card number, phone number, government ID, or a
single pixel of an image — those are stripped out in the browser before
anything is sent.

## Why this design

The core constraint: an agent that reasons well needs a powerful model, but
sending your whole screen to that model means sending your passwords, card
numbers, and photos to a third party. This splits the job in two —
**perception + redaction stay local** (DOM reading, a local face-detection
model, regex/attribute-based PII masking), **reasoning stays server-side**
(Gemini decides the next click/type/scroll from the sanitized description
only). The client also refuses, as a second line of defense, to ever act on a
field it marked sensitive — even if the server hallucinated an instruction to
fill one.

## Architecture

```
[Webpage]
   │ content_script.js walks the DOM: buttons/inputs/links, redacts PII in
   │ labels/values via redact.js (emails, phones, SSN-like IDs, Luhn-valid
   │ card numbers), never reads password field values at all
   ▼
[Sanitized JSON: {url, title, elements:[{idx, tag, label, sensitive, bbox}]}]
   │ POST /agent/step
   ▼
[FastAPI server] → prompt.py builds a prompt describing the redaction scheme
   │                 → Gemini returns {"action","target_idx","value","reasoning"}
   ▼
[background.js] → executes the action via content_script.js
   │                 → content script refuses anything targeting a
   │                   data-agent-sensitive element, regardless of server intent
   ▼
   loop until action == "done"

(in parallel, decoupled from the loop above)
[background.js] captures a viewport screenshot → [offscreen.js] runs a local
UltraFace model (ONNX Runtime Web, WASM backend, bundled weights, no network
fetch) → returns face bounding boxes only → content script draws a blur
overlay on the real page. No image bytes are ever sent to the server; this is
a visual privacy demonstration, not a gate on the agent loop.
```

**Why ONNX Runtime Web, not TensorFlow.js:** the original build used
TensorFlow.js + BlazeFace. It never actually worked inside the extension:
TF.js calls `eval()` during its own startup, and Manifest V3 permanently
forbids `unsafe-eval` for extension pages (no override exists — this isn't a
missing permission, it's a hard platform restriction). Confirmed directly by
reproducing the exact MV3 `extension_pages` CSP in a test page: TF.js threw
`EvalError: Evaluating a string as JavaScript violates ... "script-src
'self'"` immediately on load. ONNX Runtime Web's WASM backend only needs
`WebAssembly.instantiate`, which MV3 *does* allow via the `'wasm-unsafe-eval'`
CSP source (`manifest.json`'s `content_security_policy.extension_pages`) —
verified the same way, with the real shipped `offscreen.js` running
end-to-end under that exact CSP.

## Repo layout

- `extension/` — Chrome MV3 extension (side panel UI, background service
  worker, content script, offscreen document for face detection)
  - `redact.js` — single source of truth for PII regex/Luhn/attribute rules;
    also required directly by the eval harness (no logic duplication)
  - `lib/` — vendored ONNX Runtime Web (WASM backend) + UltraFace model
    (~12MB total, dominated by the ~11MB ONNX Runtime WASM binary itself —
    the face model is only ~1.2MB; bundled locally since MV3 blocks remote
    script execution)
- `server/` — FastAPI server (`main.py`), Gemini integration, JSON action
  schema (`schema.py`), prompt builder (`prompt.py`)
- `demo-site/` — two local mock sites:
  - login → profile → checkout: covers all three redaction categories
    (password, card, face) in one flow; `assets/profile-photo.jpg` is a
    public-domain (US government work) portrait used to test face detection
  - `webmail.html`: a Gmail-style inbox + compose window, for tasks like
    "email alex@example.com saying...". Several inbox rows embed a
    phone/email/card/SSN-like pattern in their preview text to demonstrate
    redacting *other people's* incidental PII sitting in the background of a
    page you didn't ask about - not just your own form fields.

    The compose "To" field is where classification gets interesting: an
    editable email field could be your own login identifier (fine to show -
    it's the same thing you'd type into a task yourself) or someone else's
    address you're about to message (should never reach the server, however
    the page happens to word the field). `classifyElementSensitivity` in
    `redact.js` tells these apart *structurally*, not by label wording: an
    email field sharing a `<form>` with a password field reads as
    login/signup; anything else defaults to a `"recipient"` category that's
    always masked to `[RECIPIENT]` on every read (before AND after being
    filled), yet still typable by the agent - a value the user names
    directly in the task can flow into it without ever being read back. This
    also means the agent needing to *verify its own past action* (a login
    email, a recipient) can't rely on the safety-net regex the way other
    free-text fields do - it needs a real value or an explicit sensitive
    category, never a guess based on field wording.
- `eval/` — `redaction_testset.json` + `run_redaction_eval.js`: precision/
  recall for PII detection and redaction, run against the exact `redact.js`
  the extension ships

## Setup & run

**1. Demo site**
```bash
python3 demo-site/serve.py 8000
```

**2. Server**
```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then edit .env and paste in your GEMINI_API_KEY
uvicorn main:app --port 8787 --reload
```
Without a key in `.env` (or the `GEMINI_API_KEY` env var) the server runs in
**stub mode** — a deterministic rule ("click/fill the first available
non-sensitive element") that proves the client/server wiring end-to-end
without needing an API key. Set the key for real reasoning. Check
`curl http://127.0.0.1:8787/healthz` to see which mode is active.

Uses the new `google-genai` SDK (the older `google-generativeai` package is
fully deprecated as of this writing) and defaults to the
`gemini-flash-lite-latest` model — a rolling alias to Google's current lite
flash model, chosen because the newest full flash model
(`gemini-3.6-flash` at time of writing) is capped at just 5 requests/minute
on the free tier, too tight for a multi-step agent loop. See
`server/.env.example` for how to override the model.

**3. Extension**
1. Open `chrome://extensions`, enable Developer mode, click "Load unpacked",
   select the `extension/` folder.
2. Click the extension icon to open the side panel (stays open while you
   interact with the page, unlike a popup).
3. Go to `http://127.0.0.1:8000/index.html`, type in the side panel's task
   box (a default task is pre-filled), click **Run task**.
4. **You** type the password on the login page and the card number/CVC on
   checkout — the agent never sees or fills these fields, by construction:
   their values never left the page.

## What's been verified

- `eval/run_redaction_eval.js` (`node eval/run_redaction_eval.js`): 100%
  precision/recall on the bundled regression set (emails, phones, SSN-like
  IDs, Luhn-valid vs. invalid card numbers, clean text, password/card/tel
  attribute classification).
- The DOM-read + redaction logic was exercised live against all three demo
  pages — password/card/phone/SSN/image fields are correctly masked, and the
  client-side guard correctly refuses to write into any of them even when
  explicitly instructed to (verified this actually triggers: Gemini has been
  observed suggesting a `type` into the password field while its own
  `reasoning` field said it shouldn't — the guard is load-bearing, not
  decorative).
- The `filled` flag (whether a sensitive field has *some* value, never what
  that value is) was added after observing the agent stall forever on
  checkout even with the card fields correctly filled in, because it had no
  way to tell "empty" from "already provided." Verified both directions:
  empty sensitive fields → correctly stalls; filled → correctly proceeds to
  click the submit button, without ever seeing the values.
- Real Gemini reasoning end-to-end, including a full simulated multi-page
  task (login → profile → checkout) against the live API.
- The ONNX Runtime Web + UltraFace face detector was verified three ways:
  (1) standalone inference against `demo-site/assets/profile-photo.jpg`
  (99.998% confidence, ~50-90ms), (2) that TF.js/BlazeFace — the original
  choice — cannot run under MV3's CSP at all, by reproducing that exact CSP
  and observing the `eval()` violation directly, and (3) that the *actual
  shipped* `offscreen.js`/`offscreen.html`/`lib/*` files, unmodified, detect
  the face correctly when served under MV3's real `extension_pages` CSP
  (`script-src 'self' 'wasm-unsafe-eval'`) with a `chrome.*` API stub.
- **Not independently verified in this session**: the full extension loaded
  in a real Chrome window end-to-end (side panel, background service worker,
  offscreen document, multi-step navigation loop, all wired together) — this
  requires `chrome://extensions`, which is hard-blocked from browser
  automation (confirmed directly: a navigate call to it gets silently
  mangled into an invalid URL). Every individual piece above was verified on
  its own, including reproducing the *exact* CSP and message-passing
  contract the real extension uses, but the full assembly needs a human to
  load it once via Developer mode → Load unpacked.

## Mapping to the evaluation criteria

| Criterion | Weight | Where |
|---|---|---|
| Accuracy of visual context from screen | 25% | `content_script.js` DOM walk (structure/labels/bboxes) + local UltraFace model (`offscreen.js`, ONNX Runtime Web) for face presence |
| PII detection recall/precision | 20% | `redact.js` rules; measured in `eval/run_redaction_eval.js` |
| Redaction precision | 20% | Same harness; also the on-screen flash-redact (page text) and per-field striped overlay (form values) + face-blur give a visible demo |
| Client-side resource utilization | 20% | Face model itself is ~1.2MB; inference measured at ~50-90ms. The ONNX Runtime WASM binary bundle is ~11MB (one-time install, not fetched per-use) — see Known limitations |
| End-to-end latency | 15% | Side panel log prints per-step DOM-read time and server round-trip time live |

## Known limitations / deliberate scope cuts

- Face detection is decoupled from the action-reasoning loop (runs async,
  purely for the visual redaction demo) — the server never receives image
  data at all, so this doesn't gate correctness of the agent's decisions.
- Redaction rules are regex/attribute-based, not ML-based — they catch
  structured PII (emails, phones, card numbers, SSN-like IDs, password/card
  autocomplete attributes) but not free-form sensitive text with no
  structural pattern (e.g. a name or diagnosis mentioned in a sentence).
- `host_permissions` is `<all_urls>` rather than scoped to `localhost` — this
  was tightened-then-loosened during debugging: `chrome.tabs.captureVisibleTab`
  turns out to require literally `<all_urls>` or `activeTab` (Chrome's own
  error message), not just a matching scoped host pattern, and `activeTab`
  proved unreliable across a long-lived side panel session. A production
  build would want to revisit this rather than requesting broad access.
- The ONNX Runtime WASM binary is ~11MB. This is inherent to bundling the
  full ONNX Runtime (needed since MV3 forbids fetching it remotely at
  runtime as executable code); shrinking it further would need a custom,
  operator-trimmed ORT build, which is out of scope here.
- A submit-type click can silently no-op if the page's own HTML form
  validation rejects it (e.g. required fields still empty) — `el.click()`
  doesn't throw in that case. `content_script.js` now checks
  `el.form.checkValidity()` after a click and surfaces a `warning` in the
  side panel log instead of reporting a misleading plain "ok".
