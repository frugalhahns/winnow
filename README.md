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
4. The setup sheet asks for one thing: a fine-grained personal access token.

Which account and repo to write to lives in `config.js`, not in the setup sheet.
Neither is a secret, so neither is worth typing. Forking Winnow means editing
those two lines. The sheet's "Writing somewhere else?" section can override them
per device if you need it.

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

## Deleting a note

Swipe a note left to uncover **Delete**, then confirm. On a desktop there is no
swipe, so hovering a note (or tabbing to it) slides the same button into view.

Deleting rewrites `data/notes.json` in the notes repo and commits. The original
capture stays in `archive/`, so nothing is truly gone. A category that loses its
last note disappears with it. `NOTES.md` catches up on the next sweep.

## Adding another device

You only enter the token once per browser, but "once per browser" still means
typing a long string on a phone. So don't. On a device that is already
connected, open settings and hit **Copy setup link**. You get:

```
https://<you>.github.io/winnow/#token=github_pat_...
```

Open that on the new device and it connects itself: the app stores the token and
strips the fragment before anything else runs.

The token rides in the URL **fragment**, not the query string. Browsers never
send fragments to the server, so it stays out of GitHub Pages access logs and out
of any `Referer` header. It does still land in whatever you paste it into, so
that link is exactly as sensitive as the token itself. Keep it in your password
manager, not in a chat message, and prefer a separate token per device if you
want to revoke one without killing the rest.

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
