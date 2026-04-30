// SetLoop — Offscreen SpeechRecognition host.
//
// Why this lives here (and not in a content script):
//   • Single mic grant — the extension-origin permission granted during
//     onboarding carries into this offscreen document. Content scripts would
//     need per-site mic grants on youtube.com, vimeo.com, etc.
//   • Survives tab switches — recognition runs regardless of which tab is
//     focused, so the musician can look at lyrics in another tab and still
//     drive the video with voice.
//   • No user-activation per tab — we never need to re-arm SR when the user
//     switches tabs.
//
// On-device only. No cloud fallback. If the on-device language pack isn't
// installed, we report "needs-install" back to the popup/onboarding and do
// not start. The recogniser is configured with processLocally:true so Chrome
// refuses to silently fall back to cloud.

const LANG = "en-US";
const SR = self.SpeechRecognition || self.webkitSpeechRecognition;

let recog = null;
let gen = 0;            // incremented on every start/stop to ignore stale events
let listening = false;  // user wants us listening
let continuous = true;  // false in PTT mode
let pttOpen = false;    // only true between ptt-down and ptt-up
let autoRestart = null; // setTimeout handle for onend → restart
let micStream = null;   // getUserMedia stream — held open so SR.start() works

function send(msg) {
  try { chrome.runtime.sendMessage({ ...msg, from: "offscreen" }); } catch {}
}

function log(...a) { console.log("[SetLoop/offscreen]", ...a); }

// Offscreen documents don't receive Chrome's mic-permission flow on their
// own — SpeechRecognition.start() throws "not-allowed" even when the user
// granted the extension origin during onboarding. The workaround is to
// hold an active getUserMedia stream for the duration of listening. We
// don't process the audio; the stream handle just keeps the permission
// "live" in this context so SR can attach to the mic.
async function acquireMic() {
  if (micStream && micStream.active) return micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    log("mic stream acquired");
    return micStream;
  } catch (e) {
    log("getUserMedia failed:", e.name, e.message);
    send({ type: "sr-error", error: "mic-" + e.name });
    return null;
  }
}

function releaseMic() {
  if (!micStream) return;
  for (const t of micStream.getTracks()) { try { t.stop(); } catch {} }
  micStream = null;
  log("mic stream released");
}

// ── On-device model check / install ─────────────────────────────────────

async function checkModel() {
  if (!SR) return { ok: false, reason: "unsupported" };
  if (typeof SR.available !== "function") {
    // Pre-Chrome-138 — no on-device surface at all.
    return { ok: false, reason: "no-on-device-api" };
  }
  try {
    const status = await SR.available({ langs: [LANG], processLocally: true });
    log("model status:", status);
    if (status === "available") return { ok: true, status };
    return { ok: false, status, reason: status };
  } catch (e) {
    log("available() threw:", e.name, e.message);
    return { ok: false, reason: "check-failed", error: e.message };
  }
}

async function installModel() {
  if (!SR || typeof SR.install !== "function") {
    return { ok: false, reason: "no-install-api" };
  }
  try {
    const result = await SR.install({ langs: [LANG], processLocally: true });
    log("install result:", result);
    return { ok: !!result, result };
  } catch (e) {
    log("install() threw:", e.name, e.message);
    return { ok: false, reason: "install-failed", error: e.message };
  }
}

// ── Recogniser lifecycle ────────────────────────────────────────────────

function buildRecogniser(mode) {
  const r = new SR();
  r.lang = LANG;
  r.continuous = mode === "always";
  r.interimResults = true;
  r.maxAlternatives = 1;
  // Tell the browser we only want on-device. On Chrome ≥138 this makes it
  // error with "language-not-supported" rather than hit the cloud.
  try { r.processLocally = true; } catch {}

  const myGen = ++gen;

  r.onstart = () => {
    if (myGen !== gen) return;
    log("SR onstart");
    send({ type: "sr-started", mode });
  };

  r.onend = () => {
    if (myGen !== gen) return;
    log("SR onend");
    send({ type: "sr-ended" });
    // Restart if the user still wants us listening. In always mode we restart
    // immediately; in PTT mode only if the key is still held.
    if (!listening) return;
    if (continuous || pttOpen) {
      clearTimeout(autoRestart);
      autoRestart = setTimeout(() => {
        if (!listening) return;
        if (!continuous && !pttOpen) return;
        startRecogniser(continuous ? "always" : "ptt");
      }, 200);
    }
  };

  r.onerror = (e) => {
    if (myGen !== gen) return;
    log("SR onerror:", e.error, e.message || "");
    send({ type: "sr-error", error: e.error });
    // "no-speech" and "aborted" are routine — onend will restart.
    // "not-allowed" / "service-not-allowed" / "language-not-supported" are fatal.
    if (e.error === "not-allowed" || e.error === "service-not-allowed" ||
        e.error === "language-not-supported" || e.error === "bad-grammar") {
      listening = false;
    }
  };

  r.onspeechstart = () => {
    if (myGen !== gen) return;
    send({ type: "sr-speech-start" });
  };

  r.onspeechend = () => {
    if (myGen !== gen) return;
    send({ type: "sr-speech-end" });
  };

  r.onresult = (e) => {
    if (myGen !== gen) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alt = res[0];
      const text = alt?.transcript?.trim();
      if (!text) continue;
      const conf = typeof alt.confidence === "number" && alt.confidence > 0
        ? alt.confidence : null;
      send({
        type: "sr-transcript",
        text,
        isFinal: res.isFinal,
        confidence: conf,
      });
    }
  };

  return r;
}

async function startRecogniser(mode) {
  if (!SR) { send({ type: "sr-error", error: "not-supported" }); return; }
  stopRecogniser(/*silent*/ true);
  // Ensure we have a live mic stream before SR tries to attach.
  const stream = await acquireMic();
  if (!stream) return;
  continuous = mode === "always";
  recog = buildRecogniser(mode);
  try {
    recog.start();
  } catch (e) {
    log("start() threw:", e.name, e.message);
    send({ type: "sr-error", error: e.name || "start-failed" });
  }
}

function stopRecogniser(silent) {
  clearTimeout(autoRestart); autoRestart = null;
  if (!recog) return;
  gen++; // invalidate any pending event handlers on the old instance
  try { recog.abort(); } catch {}
  recog = null;
  if (!silent) send({ type: "sr-ended" });
}

// ── Message routing ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== "offscreen") return;

  (async () => {
    switch (msg.type) {
      case "sr-check": {
        respond(await checkModel());
        break;
      }
      case "sr-install": {
        respond(await installModel());
        break;
      }
      case "sr-start": {
        // First make sure the model is actually ready. No silent cloud
        // fallback — if it's not installed we report and stop.
        const chk = await checkModel();
        if (!chk.ok) {
          send({ type: "sr-error", error: "model-" + (chk.reason || "unknown") });
          respond({ ok: false, ...chk });
          return;
        }
        // Acquire mic BEFORE flagging listening, so a failure here doesn't
        // leave us in a half-started state. getUserMedia uses the grant
        // made during onboarding — no prompt should appear.
        const stream = await acquireMic();
        if (!stream) { respond({ ok: false, reason: "mic" }); return; }
        listening = true;
        if (msg.mode === "ptt") {
          continuous = false;
          // PTT: don't start SR immediately — wait for sr-ptt-down. But
          // we hold the mic stream so permission is already live when the
          // user actually hits the key.
          respond({ ok: true, armed: true });
          return;
        }
        continuous = true;
        await startRecogniser("always");
        respond({ ok: true });
        break;
      }
      case "sr-stop": {
        listening = false;
        pttOpen = false;
        stopRecogniser();
        releaseMic();
        respond({ ok: true });
        break;
      }
      case "sr-ptt-down": {
        if (!listening) { respond({ ok: false }); return; }
        pttOpen = true;
        await startRecogniser("ptt");
        respond({ ok: true });
        break;
      }
      case "sr-ptt-up": {
        pttOpen = false;
        // Graceful stop — let any in-flight result finalise, then abort.
        if (recog) { try { recog.stop(); } catch {} }
        setTimeout(() => { if (!pttOpen) stopRecogniser(true); }, 500);
        respond({ ok: true });
        break;
      }
      default:
        return;
    }
  })();

  return true; // async respond
});

log("ready");
