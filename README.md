# SetLoop

Voice-controlled video looping for Chrome. Practice any section of any tutorial hands-free.

Say **"loop last 30 at 75"** — loops the last 30 seconds at 75% speed. Say **"loop stop"** when done.

## Install

[Chrome Web Store →](#) *(link when published)*

Or load unpacked:
1. Clone this repo and run `node build.js`
2. Open `chrome://extensions`, toggle Developer mode
3. Click **Load unpacked** and select the `dist/` folder

## Commands

| Command | What it does |
|---|---|
| `loop last 30 at 75` | Loop the last 30s at 75% speed |
| `loop last 20 at 50 ramp` | Start at 50%, increase speed each loop |
| `loop stop` | End the loop, restore speed |
| `wider` / `tighter` | Adjust the loop start ±2s |
| `slower` / `faster` | Adjust speed ±25% |
| `speed 63` | Set an exact speed (any %) |
| `back 10` / `forward 10` | Skip seconds |
| `bookmark` | Save the current timestamp |
| `mic off` | Turn off the microphone |

Tip: prefix short commands with "loop" (`loop stop`, `loop slower`) in Always-On mode so ambient speech from the video doesn't trigger actions.

## Modes

- **Always On** — mic stays on, speak commands anytime
- **Push-to-Talk** — hold the `` ` `` key, speak, release. Most reliable in noisy rooms.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+V` | Toggle voice on/off |
| `Alt+B` | Bookmark the current time |
| Hold `` ` `` | Push-to-Talk (when in PTT mode) |

## Privacy

SetLoop uses Chrome's built-in `SpeechRecognition` API. While the mic is active, Chrome transmits audio to Google's speech service and returns a transcript. SetLoop reads the transcript, matches a command, and acts — it does not store or forward the audio itself.

- No accounts, analytics, tracking, or telemetry
- No host permissions
- Bookmarks and preferences stay on your device via `chrome.storage.local`

Full policy: [PRIVACY.md](./PRIVACY.md)

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the current tab when you activate SetLoop |
| `storage` | Save bookmarks and preferences locally |
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

## License

MIT
