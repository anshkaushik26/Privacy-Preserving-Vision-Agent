# Security Policy

TSE (Privacy-Preserving Vision Agent) is a student project built for Smart India Hackathon 2026. It is maintained on a best-effort basis, but it handles page content, so security and privacy reports are taken seriously.

## Supported versions

Only the latest version is supported: the current `main` branch and the version published on the [Chrome Web Store](https://chromewebstore.google.com/detail/privacy-preserving-vision/lbicleoplkoboijbhmdmnmmpckbkcpil). Older versions will not receive fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Email **anshkaushik2007@gmail.com** with:

- a description of the problem and its impact,
- steps to reproduce (the page or input that triggers it, and the extension version),
- anything that shows what data was exposed or what action was taken.

You can expect a reply within about a week. This is a small project, so that is a goal, not a guarantee. Please give me a reasonable chance to fix an issue before disclosing it publicly.

## What is in scope

- **Redaction failures:** sensitive data (passwords, card numbers, government IDs, tokens and similar) reaching the server or the language model in the request payload.
- **Guard bypasses:** getting the extension to type into a field it classified as sensitive, or to click Send or Submit when the task did not ask for it.
- **Server issues:** authentication bypass on `/agent/step`, injection, or leaking request content or keys.
- **Report page:** any way for page content to run script in the extension's pages, or for the report to be saved or transmitted.

## Known limitations (not treated as vulnerabilities)

These are documented design limits, so reports about them alone are not security bugs, though suggestions are welcome:

- Detection is rule-based and best-effort, with no formal guarantee. PII written as free prose without a keyword (for example, a name or address in a sentence), text inside images or canvas, and content in iframes or shadow DOM may not be caught.
- The extension does not defend against prompt injection from page content.
- The shared secret in the extension only filters casual abuse of the public server. Anyone can read it by unpacking the extension, so it is not authentication.
- Screenshots and the "View full report" data stay on the device and are held in memory only, but the browser itself and other extensions are outside this project's control.

## What the extension sends

See [PRIVACY.md](PRIVACY.md) for exactly what is and is not transmitted.

## Credentials

Do not commit API keys. The Gemini key is read from the server's environment (or a git-ignored `.env`) and is never part of the extension. If you find a credential in this repository, report it as above.
