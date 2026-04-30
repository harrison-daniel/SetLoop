# SetLoop

Voice-controlled video looping for Chrome. Practice any section of any tutorial hands-free.

**Say "loop last 30 at 75"** → loops the last 30 seconds at 75% speed. Say **"loop stop"** when done.

## Install

[Chrome Web Store →](#) *(link when published)*

Or load unpacked: clone this repo → `chrome://extensions` → Developer Mode → Load Unpacked → select folder.

## Commands

| Command | What it does |
|---|---|
| `loop last 30 at 75` | Loop last 30s at 75% speed |
| `loop last 20 at 50 ramp` | Start at 50%, increase speed each loop |
| `loop stop` | End loop, restore original speed |
| `wider` / `tighter` | Adjust loop start ±2s |
| `slower` / `faster` | Adjust speed ±25% |
| `speed 63` | Set exact speed (any %) |
| `back 10` / `forward 10` | Skip seconds |
| `bookmark` | Save current timestamp |
| `mic off` | Turn off microphone |

**Tip:** Prefix short commands with "loop" (e.g. `loop stop`, `loop slower`) for better voice detection.

## Modes

- **Always On** (default) — mic stays on, speak commands anytime
- **Push-to-Talk** — hold `` ` `` key, speak, release. Most reliable.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+V` | Toggle voice on/off |
| `Alt+B` | Bookmark current time |
| Hold `` ` `` | Push-to-Talk |

## Privacy

- **Zero data collection** — nothing recorded, stored, or sent
- Mic only active when you enable it
- No accounts, no tracking, no analytics, no network requests
- All preferences stored locally via `chrome.storage.local`
- Chrome's Web Speech API may use Google servers for transcription — that's Chrome's behavior, not ours

Full privacy policy: [setloop.app/privacy](https://setloop.app/privacy)

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access current tab to inject looping script |
| `storage` | Save bookmarks and preferences locally |
| `scripting` | Inject content script when you activate SetLoop |

No host permissions. No `<all_urls>`. Zero footprint on pages you don't use it on.

## Tech

- Manifest V3
- Vanilla JS, no dependencies, no build step
- 22KB packaged
- CSP: `script-src 'self'; object-src 'self'`

## License

MIT
