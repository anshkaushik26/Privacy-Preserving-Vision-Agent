# Privacy-Preserving Vision Agent (TSE — The Safe Extension)

A Chrome extension that lets an AI agent operate a web page for you while sensitive data is detected and removed **inside the browser** before anything reaches the cloud language model.

Built by team CodeXCapsules for Smart India Hackathon 2026, problem statement **SIH26171** — *On-device Visual Perception for Light-weight Browser Agents*.

## Install

**[Chrome Web Store (unlisted listing)](https://chromewebstore.google.com/detail/privacy-preserving-vision/lbicleoplkoboijbhmdmnmmpckbkcpil)**

Or load it unpacked: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and choose the `extension/` folder.

## What it does

1. A content script reads the page and lists its interactive elements.
2. Each element is classified structurally (type, autocomplete, form context) and its text is scanned for 20+ PII categories (cards with Luhn, Aadhaar with Verhoeff, PAN, IFSC, UPI, phone, email, OTP, API keys, ...). Sensitive values are dropped locally.
3. Only a structure-only description plus your task is sent to the server, which asks Gemini for one action (`click`, `type`, `scroll` or `done`). Screenshots never leave the device.
4. Deterministic guards run in code, not in the prompt: a re-scan of the whole outgoing payload, refusal to type into sensitive fields, and a send/submit guard.
5. **View full report** shows the page before and after redaction, the detected elements, and the exact JSON that was sent. It is held in memory only and is never saved.

Faces are detected on-device (UltraFace via ONNX Runtime Web / WebAssembly) and blurred on screen.

## Repository layout

| Path | Contents |
| --- | --- |
| `extension/` | Chrome MV3 extension: content script, redaction engine (`redact.js`), background loop, side panel, report page |
| `server/` | FastAPI server that forwards the sanitized page description to Gemini (Dockerfile for Cloud Run) |
| `eval/` | Redaction regression suite: `node eval/run_redaction_eval.js` |
| `demo-site/` | Local mock site for safe, repeatable testing |
| `PRIVACY.md` | Privacy policy |

## Run the server locally

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # add your GEMINI_API_KEY
.venv/bin/uvicorn main:app --port 8787
```

Then put `http://127.0.0.1:8787/agent/step` in the extension's server URL field.

## Development

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest
cd .. && node eval/run_redaction_eval.js     # redaction regression suite (exits non-zero on any miss)
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push. Server tests never call Gemini and ignore any real key in your environment.

**Dependencies.** `server/requirements.in` lists the direct dependencies; `server/requirements.txt` is the fully pinned set the Docker image installs (the versions the live Cloud Run revision was built with). To upgrade, change `requirements.in`, resolve and test in a clean Python 3.12 environment, then update `requirements.txt` (Dependabot opens weekly PRs for this). `extension/lib/` holds vendored ONNX Runtime and the face model; their versions are not tracked yet.

## Status and limits

- Detection is rule-based and best-effort, with no formal guarantee. The 76-case test suite was written by the same team as the rules, so it is a regression suite, not an independent accuracy measure.
- Not covered: PII in free prose without keywords, text inside images or canvas, iframes and shadow DOM, and prompt injection from page content.
