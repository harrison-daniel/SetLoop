# SetLoop — Privacy Policy

**Last updated:** March 2026

## The short version

SetLoop does **not** collect, store, transmit, or share any user data.

## Microphone

- Your mic activates **only** when you explicitly enable voice control (via Alt+V, the popup toggle, or the overlay button).
- In Push-to-Talk mode, the mic is only active while you hold the designated key.
- It is **immediately released** when you turn it off.
- SetLoop does not record, store, or transmit audio.
- All voice processing — including voice activity detection (Silero VAD) and speech-to-text (Whisper) — runs entirely on your device using bundled models. No audio data is sent to any server.

## Local storage

- Bookmarks and mode preferences are stored on your device via `chrome.storage.local`. They never leave your machine.
- No browsing history, video URLs, transcripts, or personal data is collected.

## No data sharing

- No analytics, tracking, or telemetry
- No third-party services, SDKs, or ad networks
- No remote servers or API calls
- No accounts or sign-ups

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab when you activate SetLoop |
| `storage` | Save bookmarks and preferences locally on your device |
| `scripting` | Inject the video control script on the current tab |
| `offscreen` | Run voice detection and transcription models in a background document |

No host permissions are requested. SetLoop has no blanket access to your browsing data. The extension makes zero network requests.

## Chrome Web Store compliance

The use of information received from Google APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies), including the Limited Use requirements.

## Open source

The full source code is available for inspection at [github.com/harrison-daniel/SetLoop](https://github.com/harrison-daniel/SetLoop). Every claim in this policy can be verified by reading the code.

## Contact

Questions? Reach the developer at [your-email@example.com].
