# SetLoop — Privacy Policy

**Last updated:** April 2026

## Summary

SetLoop does not create accounts, run analytics, or operate any servers. Voice commands are transcribed by Chrome's built-in speech service (Google) while the mic is active. Bookmarks and preferences stay on your device.

## Microphone

- Your mic activates only when you explicitly enable voice control (Alt+V, the popup toggle, or the overlay button).
- In Push-to-Talk mode, the mic is only active while you hold the key.
- The mic is released the moment you turn voice control off.

## Voice detection (local)

- SetLoop runs [Silero VAD](https://github.com/snakers4/silero-vad), a small neural voice-activity-detection model, locally in your browser via ONNX Runtime Web.
- The model is bundled with the extension (~2 MB). No data, audio, or inference output ever leaves your device.
- Silero's job is to decide whether the mic is currently picking up a human voice (vs. video audio bleeding through laptop speakers). SetLoop only acts on commands while Silero says "yes, close-mic voice."

## Speech recognition

- SetLoop calls `SpeechRecognition`, a standard Web API built into Chrome.
- While the mic is active, Chrome streams audio to its speech service (Google cloud, or Chrome's on-device model when available) and returns a transcript.
- SetLoop reads that transcript, matches a command, and acts on your video. The transcript is not stored.
- Google's handling of speech audio is covered by [Google's privacy policy](https://policies.google.com/privacy). That transmission is performed by Chrome itself when SetLoop invokes the API; SetLoop never reads, stores, or forwards raw audio.

## Local storage

- Bookmarks and preferences are stored via `chrome.storage.local` on your device. They never leave your machine.
- No browsing history, video URLs, transcripts, or personal data is collected by SetLoop.

## What SetLoop does not do

- No analytics, tracking, telemetry, or fingerprinting
- No third-party SDKs, ad networks, or social integrations
- No accounts or sign-ups
- No remote servers operated by SetLoop
- No host permissions — SetLoop never reads pages you don't invoke it on

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab when you activate SetLoop |
| `storage` | Save bookmarks and preferences locally on your device |
| `scripting` | Inject the overlay/control script on the current tab |
| `offscreen` | Run the local voice-detection model and speech API in a background document |

No host permissions are declared.

## Chrome Web Store compliance

Use of information received from Google APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies), including the Limited Use requirements.

## Open source

Full source code is available at [github.com/harrison-daniel/SetLoop](https://github.com/harrison-daniel/SetLoop). Every claim above can be verified by reading the code.

## Contact

Questions? Open an issue at [github.com/harrison-daniel/SetLoop/issues](https://github.com/harrison-daniel/SetLoop/issues).
