# Winnow

Dump a note, a link, a half-formed idea. A daily AI sweep sorts it.

This repo is the **frontend only**: a static PWA served from GitHub Pages. It is
public so that Pages is free. It contains **no notes**.

Your notes live in a separate **private** repo (`winnow-store` by default), which
also runs the scheduled Gemini sweep. See that repo's README for the pipeline.

## How it fits together

```
[Winnow PWA]  --Contents API (your PAT)-->  winnow-store/inbox/*.md
                                                     |
                                     [daily Action]  |  Gemini categorizes
                                                     v
                                            winnow-store/data/notes.json
                                                     |
[Winnow PWA Browse tab]  <--Contents API (your PAT)--+
```

## Setup

1. Create the private notes repo first (`winnow-store`), then come back here.
2. **Settings > Pages > Source: GitHub Actions.** Push to `main` deploys.
3. Open `https://<you>.github.io/winnow`.
4. The setup sheet asks for three things:
   - GitHub username
   - private notes repo name
   - a fine-grained personal access token

### The token

Create at **Settings > Developer settings > Personal access tokens > Fine-grained
tokens**:

- **Resource owner:** your account
- **Repository access:** Only select repositories, pick `winnow-store` only
- **Permissions:** Repository permissions > **Contents: Read and write**
- **Expiration:** whatever you will tolerate re-entering

Nothing else. No `repo` classic token.

The token is stored in this browser's `localStorage` and is sent only to
`api.github.com`. Understand the tradeoff: anyone with your unlocked device, or
any script injected into this page, can read it. Scoped as above, the worst it
can do is read and write files in that one repo. It cannot touch your other
repos, your org, or delete anything outside it. Revoke from the same settings
page at any time; "Disconnect" in the app only clears it from this device.

Notes are always rendered as text, never as HTML, so a note containing markup
cannot execute.

## Install on your phone

- **iOS:** Safari > Share > Add to Home Screen. Runs full screen, no browser bar.
- **Android:** Chrome > menu > Install app.

The app queues notes in `localStorage` when offline and flushes them when the
network returns.

### Faster capture with an iOS Shortcut

The app reads `?text=` and `?url=` on load and prefills the box. Make a Shortcut
that accepts URLs from the share sheet and opens:

```
https://<you>.github.io/winnow/?url=[Shortcut Input]
```

Two taps from any app to a prefilled note.

## Local development

Any static server works, but it must be over `http://localhost` for the service
worker to register:

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Shell, capture form, browse view, setup sheet |
| `app.js` | Capture queue, GitHub Contents API calls, rendering |
| `styles.css` | Warm-dark theme, light mode via `prefers-color-scheme` |
| `sw.js` | Offline app shell. Never intercepts `api.github.com` |
| `manifest.webmanifest` | PWA install metadata |
| `assets/` | Icon, SVG source plus rendered PNGs |
