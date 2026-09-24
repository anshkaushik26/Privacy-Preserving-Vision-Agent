# Privacy Policy — TSE (Privacy-Preserving Vision Agent)

**Last updated:** September 2026

TSE is a Chrome extension built for Smart India Hackathon 2026 (Problem Statement
26171). It lets you type a task in plain language (e.g. "compose an email to my
boss") and automates it on the current webpage, while redacting personal and
sensitive information locally before anything reaches a cloud AI model.

## What the extension reads

When you run a task, TSE reads the structure of the currently active tab's page
(element types, labels, and positions — such as buttons, links, and form fields)
so it can decide what to click or type. It also takes a local screenshot to run
an on-device face-detection model.

## What never leaves your device

- **Any value classified as sensitive** — passwords, card numbers, government ID
  numbers, bank details, API keys, and about a dozen other categories — is
  detected and dropped locally. These values are never transmitted in any form.
- **Screenshots and images** never leave your device. Face detection runs fully
  in-browser (via WebAssembly); only the resulting on-screen blur is drawn
  locally, and the image itself is discarded afterward.
- A second, independent check re-scans the entire outgoing message immediately
  before it is sent, as a safety net.

## What is sent, and to whom

Only a sanitized, structural description of the page (element types, non-sensitive
labels, and your typed task) is sent to our server, which forwards it to Google's
Gemini API to decide the next action. Google's Gemini API is a third-party
service; see [Google's Gemini API terms](https://ai.google.dev/gemini-api/terms)
for how Google handles data sent to it. Our own server does not log or store the
content of these requests beyond what is needed to return a response.

## What we don't do

- We don't sell or share your data with advertisers.
- We don't track you across other websites.
- We don't require an account or collect your name, email, or other identifying
  information to use the extension.

## Permissions

TSE requests broad host permissions (`<all_urls>`) and scripting access because
it needs to read and act on whatever page you direct it to — by design, it works
generically across sites rather than being limited to a fixed list. It only acts
when you explicitly run a task.

## Contact

Questions about this policy: anshkaushik2007@gmail.com
