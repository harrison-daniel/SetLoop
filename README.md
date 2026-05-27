# SetLoop

[![build](https://github.com/harrison-daniel/SetLoop/actions/workflows/build.yml/badge.svg)](https://github.com/harrison-daniel/SetLoop/actions/workflows/build.yml)

Voice-controlled video looping for Chrome. Loop any section, adjust speed, and bookmark moments hands-free — or use customizable on-screen controls with preset loop buttons for precise tuning.

Say **"loop last 30 at 75"** — loops the last 30 seconds at 75% speed. Say **"loop stop"** when done.

## Install

[Chrome Web Store →](#) _(link when published)_

Or load unpacked:

1. Clone this repo and run `node build.js`
2. Open `chrome://extensions`, toggle Developer mode
3. Click **Load unpacked** and select the `dist/` folder

## Commands

| Command                   | What it does                           |
| ------------------------- | -------------------------------------- |
| `loop last 30 at 75`      | Loop the last 30s at 75% speed         |
| `loop last 20 at 50 ramp` | Start at 50%, increase speed each loop |
| `loop stop`               | End the loop, restore speed            |
| `wider` / `tighter`       | Adjust the loop start ±2s              |
| `slower` / `faster`       | Adjust speed ±25%                      |
| `speed 63`                | Set an exact speed (any %)             |
| `back 10` / `forward 10`  | Skip seconds                           |
| `bookmark`                | Save the current timestamp             |
| `mic off`                 | Turn off the microphone                |

Tip: prefix short commands with "loop" (`loop stop`, `loop slower`) in Always-On mode so ambient speech from the video doesn't trigger actions.

## Modes

- **Always On** — mic stays on, speak commands anytime
- **Push-to-Talk** — hold the `` ` `` key, speak, release. Most reliable in noisy rooms.

## Keyboard shortcuts

| Shortcut     | Action                          |
| ------------ | ------------------------------- |
| `Alt+V`      | Toggle voice on/off             |
| `Alt+B`      | Bookmark the current time       |
| Hold `` ` `` | Push-to-Talk (when in PTT mode) |

## Privacy

SetLoop uses Chrome's built-in `SpeechRecognition` API. While the mic is active, Chrome transmits audio to Google's speech service and returns a transcript. SetLoop reads the transcript, matches a command, and acts — it does not store or forward the audio itself.

- No accounts, analytics, tracking, or telemetry
- No host permissions
- Bookmarks and preferences stay on your device via `chrome.storage.local`

Full policy: [PRIVACY.md](./PRIVACY.md)

## Permissions

| Permission  | Why                                                  |
| ----------- | ---------------------------------------------------- |
| `activeTab` | Access the current tab when you activate SetLoop     |
| `storage`   | Save bookmarks and preferences locally               |
| `scripting` | Inject the overlay/control script on the current tab |

## Tech

- Manifest V3
- Zero runtime dependencies, no build-time compilation, vanilla JS
- CSP: `script-src 'self'; object-src 'self'`
- `SpeechRecognition` runs in the content script (page origin) so user-gesture propagation is clean and mic permission follows the standard per-site prompt

## Build

```
node build.js
```

Output in `dist/`. Load that folder as an unpacked extension.

### Development workflow

For local development, load the **repo root** (not `dist/`) as the unpacked extension. The source has `DEBUG = true`, so console logs (`[SetLoop] …`) appear in DevTools — invaluable for diagnosing SR lifecycle issues. Only load one copy of the extension at a time (root OR dist, never both).

```
chrome://extensions → Load unpacked → select repo root
```

`build.js` strips `DEBUG` to `false` when producing `dist/` for shipping. Never ship the root folder; always ship `dist/`.

## Repo layout

```
SetLoop/
├── manifest.json, *.js, *.html, *.css   ← extension source
├── build.js                              ← build script (zero deps)
├── icons/                                ← extension + website icons
├── site/                                 ← Cloudflare Pages root (setloop.app)
│   ├── index.html                        ← landing page
│   ├── privacy/index.html                ← auto-mirrored from root privacy.html
│   └── icons/                            ← auto-mirrored from root icons/
├── dist/                                 ← extension build output (gitignored)
└── .github/workflows/build.yml           ← CI: builds extension on every push
```

`build.js` produces `dist/` for the Chrome Web Store and syncs `privacy.html` + `icons/` into `site/` so `setloop.app/privacy` always matches the in-extension privacy page.

## License

MIT
