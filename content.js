// SetLoop — Content script.
//
// Runs on supported video pages. Owns:
//   • On-page overlay (pill, HUD, toasts, quick actions, bookmarks)
//   • Loop / speed engine
//   • Grammar-driven command parser
//   • SpeechRecognition host
//
// SR runs here because the popup-click → chrome.scripting.executeScript
// route preserves user activation into this isolated world, which is what
// webkitSpeechRecognition.start() needs. Chrome handles the audio
// pipeline — SetLoop itself never touches, records, or forwards audio.
// First use on a new site prompts for mic once, then the grant sticks.

(() => {
  "use strict";
  const VL_VERSION = "1.1.0";
  if (window.__vl === VL_VERSION) return;
  // If an older injection exists, tear down its overlay so the new
  // content script can reinitialize cleanly. Happens during dev reloads;
  // in production users just refresh the tab after extension updates.
  if (window.__vl) {
    document.getElementById("vl-root")?.remove();
    document.getElementById("vlHud")?.remove();
  }
  window.__vl = VL_VERSION;

  const DEBUG = true;
  const log = (...a) => { if (DEBUG) console.log("[SetLoop]", ...a); };

  const TOAST_MS = 2200;
  const RAMP_STEP = 0.05;
  const FIRE_DEDUP_MS = 6000;   // wide enough to cover interim → recycle → final
  const STABLE_INTERIM_MS = 300; // parameterized cmd must persist this long to fire on interim
  const DUCK_RATIO = 0.25;      // video volume while listening (if auto-duck on)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Watchdog tuning. Chrome's SpeechRecognition can silently go deaf without
  // firing onend, so we use SR's own onspeechstart as the stall signal:
  // if SR detected speech but didn't return a result within SR_STALL_MS,
  // the recogniser has hung — recycle. We do NOT use raw mic audio levels
  // for stall detection; with laptop speakers playing video, the mic always
  // hears audio and that gives constant false stalls.
  const WATCHDOG_POLL_MS    = 750;   // re-check every 0.75s — faster catch on rapid-command sessions
  const SR_STALL_MS         = 3500;  // recycle if speechstart fired but no result in 3.5s
  const SR_HARD_RECYCLE_MS  = 75000; // pre-emptive recycle before Chrome auto-kill (~90-120s)
  const SR_RECENT_SPEECH_MS = 6000;  // defer pre-emptive recycle if user spoke this recently
  // Deaf-SR: if SR has been running past warmup with ZERO audio activity
  // (no onspeechstart, no results), Chrome's speech service has gone quiet.
  // Recycle early rather than waiting 75s for the hard recycle.
  const SR_DEAF_MS          = 8000;  // was 18s — 8s is plenty for a music practice session

  // Audio-monitor tuning (dual-source: mic + video.captureStream reference).
  // Logic: a sample is "real user voice" when mic RMS is meaningfully above
  // both the rolling ambient noise floor AND the video's own audio output.
  // This replaces a fixed RMS threshold with a self-calibrating, video-aware
  // gate that handles any speaker volume and any mic gain without tuning.
  const AUDIO_POLL_MS       = 100;     // sample mic + video RMS every 100ms
  const NOISE_FLOOR_WINDOW  = 50;      // rolling window of silence samples (~5s)
  const VIDEO_BLEED_FACTOR  = 1.4;     // mic must be ≥1.4× videoRMS to count as voice
  const VOICE_FLOOR_FACTOR  = 3;       // mic must be ≥3× ambient noise floor
  const VIDEO_LOUD_RMS      = 0.02;    // videoRMS above this = "speakers are audible"

  // Aggressive ducking: when SR detects speech start, drop video to this
  // ratio so commands aren't drowned by speaker audio. Restored on
  // onspeechend or final result.
  const SPEECH_DUCK_RATIO = 0.15;

  // Bleed-detection: if many finals arrive but none match a command, the
  // mic is probably hearing video audio. Surface a one-shot toast offering
  // PTT mode. Reset on first successful command.
  const BLEED_WINDOW_MS    = 60000;
  const BLEED_NONFIRE_MIN  = 5;

  const DEFAULT_QUICK_ACTIONS = [
    { label: "⟳20s 75%", secs: 20, spd: 0.75 },
    { label: "⟳30s 50%", secs: 30, spd: 0.50 },
    { label: "■ Stop", secs: 0, spd: 0 },
  ];

  const state = {
    listening: false,
    mode: "always",
    pttKey: "Backquote",
    pttHeld: false,
    strict: true,           // ON by default — blocks bare "stop"/"pause" from video bleed
    duck: false,            // auto-duck video volume while listening
    duckedVolume: null,     // saved volume pre-duck
    loop: {
      active: false, start: 0, end: 0, interval: null, preRate: 1,
      count: 0, ramp: false, markStart: null,
    },
    bookmarks: [],
    videoId: getVid(),
    quickActions: DEFAULT_QUICK_ACTIONS.slice(),
    editing: false,
    speechStartTime: null,
    speaking: false,
  };

  // ── Config ────────────────────────────────────────────────────────────

  chrome?.storage?.local?.get("vl_cfg", (d) => {
    const c = validateCfg(d?.vl_cfg);
    if (!c) { saveCfg(); return; }
    state.mode = c.mode;
    state.pttKey = c.pttKey;
    state.strict = c.strict;
    state.duck = c.duck;
    state.quickActions = c.quickActions;
  });

  function validateCfg(c) {
    if (!c || typeof c !== "object") return null;
    return {
      mode: ["always", "ptt"].includes(c.mode) ? c.mode : "always",
      pttKey: typeof c.pttKey === "string" && c.pttKey.length < 30 ? c.pttKey : "Backquote",
      strict: typeof c.strict === "boolean" ? c.strict : true,
      duck: !!c.duck,
      quickActions: Array.isArray(c.quickActions)
        ? c.quickActions.filter(q =>
            q && typeof q.secs === "number" && q.secs >= 0 && q.secs <= 300 &&
            typeof q.spd === "number" && q.spd >= 0 && q.spd <= 4 &&
            typeof q.label === "string" && q.label.length < 50
          ).slice(0, 10)
        : DEFAULT_QUICK_ACTIONS.slice(),
    };
  }

  function saveCfg() {
    try {
      chrome?.storage?.local?.set({
        vl_cfg: {
          mode: state.mode, pttKey: state.pttKey,
          strict: state.strict, duck: state.duck,
          quickActions: state.quickActions,
        },
      });
    } catch {}
  }

  function syncState() {
    try {
      chrome?.storage?.local?.set({
        vl_state: {
          listening: state.listening,
          loopActive: state.loop.active,
          mode: state.mode,
        },
      });
    } catch {}
    chrome.runtime.sendMessage({
      type: "state-update",
      listening: state.listening,
      loopActive: state.loop.active,
    }, () => void chrome.runtime.lastError);
  }

  // ── Page / video helpers ──────────────────────────────────────────────

  function $(s) { return document.querySelector(s); }
  function isYouTube(h) { return h === "youtube.com" || h === "www.youtube.com" || h === "m.youtube.com"; }
  function pageKind() {
    try {
      const u = new URL(location.href);
      if (isYouTube(u.hostname)) {
        if (u.pathname.startsWith("/shorts/")) return "youtube-shorts";
        if (u.pathname === "/watch") return "youtube-watch";
        return "youtube-other";
      }
      if (document.querySelector("video")) return "video";
      return "no-video";
    } catch { return "unknown"; }
  }
  function isSupportedPage() {
    const k = pageKind();
    return k === "youtube-watch" || k === "video";
  }
  function getVid() {
    try {
      const u = new URL(location.href);
      return isYouTube(u.hostname) ? (u.searchParams.get("v") || u.pathname) : u.pathname;
    } catch { return location.href; }
  }
  function fmt(s) { return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function getVideo() {
    const a = [...document.querySelectorAll("video")];
    if (!a.length) return null;
    return a.reduce((x, y) => {
      const ra = x.getBoundingClientRect(), rb = y.getBoundingClientRect();
      return (rb.width * rb.height) > (ra.width * ra.height) ? y : x;
    });
  }
  function tsUrl(t) {
    try {
      const u = new URL(location.href);
      if (isYouTube(u.hostname)) u.searchParams.set("t", `${Math.floor(t)}s`);
      else u.hash = `t=${Math.floor(t)}`;
      return u.toString();
    } catch { return location.href; }
  }
  function copyText(t) {
    navigator.clipboard.writeText(t).catch(() => {
      const e = document.createElement("textarea");
      e.value = t; e.style.cssText = "position:fixed;left:-9999px";
      document.body.appendChild(e); e.select(); document.execCommand("copy");
      document.body.removeChild(e);
    });
  }

  let audioCtx = null;
  function beep(freq = 880, dur = 0.08) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // Context can come back suspended after the tab is backgrounded; without
      // resume() the beep is silent until the next user gesture.
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = freq; o.type = "sine"; g.gain.value = 0.08;
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.stop(audioCtx.currentTime + dur);
    } catch {}
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────

  function loadBm() {
    chrome?.storage?.local?.get(`vl_bm_${state.videoId}`, (d) => {
      state.bookmarks = validateBookmarks(d?.[`vl_bm_${state.videoId}`]);
    });
  }
  function saveBm() { chrome?.storage?.local?.set({ [`vl_bm_${state.videoId}`]: state.bookmarks }); }
  function addBm() {
    const v = getVideo(); if (!v) return;
    const t = v.currentTime;
    state.bookmarks.push({
      id: Date.now(), time: t, label: fmt(t),
      speed: v.playbackRate, created: new Date().toISOString(),
    });
    saveBm(); beep();
    toast(`Bookmarked ${fmt(t)}`);
    showHud(`Bookmarked ${fmt(t)}`, "info");
  }
  function validateBookmarks(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(b =>
      b && typeof b.id === "number" &&
      typeof b.time === "number" && b.time >= 0 &&
      typeof b.label === "string" && b.label.length < 100
    ).slice(0, 200);
  }

  // ── Overlay ───────────────────────────────────────────────────────────

  let overlay = null, toastTmr = null;
  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement("div"); overlay.id = "vl-root";
    overlay.innerHTML = `
      <div class="vl-pill" id="vlPill">
        <div class="vl-dot" id="vlDot"></div>
        <span class="vl-label" id="vlLabel">SetLoop</span>
        <div class="vl-progress" id="vlProgress"></div>
        <button class="vl-btn" id="vlMic" title="Toggle voice (Alt+V)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
        <button class="vl-btn" id="vlBm" title="Bookmark (Alt+B)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
        <button class="vl-btn" id="vlCopy" title="Copy URL"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
      </div>
      <div class="vl-qa-row"><div class="vl-quick" id="vlQuick"></div><button class="vl-edit-btn" id="vlEdit" title="Edit presets">⚙</button></div>
      <div class="vl-tl" id="vlTl" hidden>
        <div class="vl-tl-track" id="vlTlTrack">
          <div class="vl-tl-loop" id="vlTlLoop"></div>
          <div class="vl-tl-h vl-tl-hs" id="vlTlHs" title="Drag to move loop start"></div>
          <div class="vl-tl-h vl-tl-he" id="vlTlHe" title="Drag to move loop end"></div>
          <div class="vl-tl-head" id="vlTlHead"></div>
        </div>
        <div class="vl-tl-labels">
          <span id="vlTlLs"></span>
          <span id="vlTlLe"></span>
        </div>
      </div>
      <div class="vl-tip" id="vlTip" hidden>
        <span id="vlTipText"></span>
        <button class="vl-tip-action" id="vlTipAction" type="button"></button>
        <button class="vl-tip-x" id="vlTipDismiss" type="button" aria-label="Dismiss">×</button>
      </div>
      <div class="vl-toast" id="vlToast"></div>`;
    document.body.appendChild(overlay);
    const hud = document.createElement("div");
    hud.id = "vlHud"; hud.className = "vl-hud";
    hud.innerHTML = `<span id="vlHudText" class="vl-hud-text"></span>`;
    document.body.appendChild(hud);
    $("#vlMic").addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    $("#vlBm").addEventListener("click", (e) => { e.stopPropagation(); addBm(); });
    $("#vlCopy").addEventListener("click", (e) => {
      e.stopPropagation();
      const v = getVideo();
      if (v) { copyText(tsUrl(v.currentTime)); beep(); toast("Link copied"); }
    });
    $("#vlEdit").addEventListener("click", (e) => { e.stopPropagation(); toggleEdit(); });
    renderQA(); drag($("#vlPill"));
  }

  function renderQA() {
    const el = $("#vlQuick"); if (!el) return;
    el.textContent = "";

    if (state.editing) {
      const editable = state.quickActions.filter(q => q.secs > 0);
      editable.forEach((q, i) => {
        const wrap = document.createElement("div");
        wrap.className = "vl-qa-edit";
        const secInput = document.createElement("input");
        secInput.type = "number"; secInput.className = "vl-qa-input";
        secInput.value = q.secs; secInput.min = 1; secInput.max = 300;
        secInput.dataset.f = "secs"; secInput.dataset.i = i;
        const secLabel = document.createElement("span");
        secLabel.className = "vl-qa-at"; secLabel.textContent = "s";
        const spdInput = document.createElement("input");
        spdInput.type = "number"; spdInput.className = "vl-qa-input";
        spdInput.value = Math.round(q.spd * 100); spdInput.min = 10; spdInput.max = 200;
        spdInput.dataset.f = "spd"; spdInput.dataset.i = i;
        const spdLabel = document.createElement("span");
        spdLabel.className = "vl-qa-at"; spdLabel.textContent = "%";
        wrap.append(secInput, secLabel, spdInput, spdLabel);
        el.appendChild(wrap);
      });

      const resetBtn = document.createElement("button");
      resetBtn.className = "vl-qa vl-qa-reset"; resetBtn.textContent = "↺";
      resetBtn.title = "Reset to defaults";
      resetBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.quickActions = DEFAULT_QUICK_ACTIONS.slice();
        saveCfg(); state.editing = false; renderQA();
        toast("Presets reset");
      });
      el.appendChild(resetBtn);

      const saveBtn = document.createElement("button");
      saveBtn.className = "vl-qa vl-qa-save"; saveBtn.textContent = "✓";
      saveBtn.title = "Save";
      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        el.querySelectorAll(".vl-qa-input").forEach(inp => {
          const idx = +inp.dataset.i, f = inp.dataset.f;
          const qa = state.quickActions.filter(q => q.secs > 0)[idx];
          if (!qa) return;
          if (f === "secs") qa.secs = clamp(+inp.value, 1, 300);
          if (f === "spd") qa.spd = clamp(+inp.value / 100, 0.1, 4);
          qa.label = `⟳${qa.secs}s ${Math.round(qa.spd * 100)}%`;
        });
        saveCfg(); state.editing = false; renderQA();
      });
      el.appendChild(saveBtn);
    } else {
      state.quickActions.forEach((q) => {
        const btn = document.createElement("button");
        btn.className = "vl-qa"; btn.textContent = q.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (q.secs === 0 && q.spd === 0) exec({ a: "stop" });
          else exec({ a: "loop_last", secs: q.secs, spd: q.spd });
        });
        el.appendChild(btn);
      });
    }
  }
  function toggleEdit() {
    state.editing = !state.editing;
    const b = $("#vlEdit");
    if (b) b.textContent = state.editing ? "✕" : "⚙";
    renderQA();
  }

  function posHud() {
    const h = document.getElementById("vlHud");
    const qaRow = document.querySelector(".vl-qa-row");
    const pill = document.getElementById("vlPill");
    if (!h) return;
    const anchor = qaRow || pill; if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    h.style.right = "12px"; h.style.left = "auto";
    h.style.top = `${r.bottom + 8}px`;
  }
  function showHud(text, type) {
    const el = document.getElementById("vlHudText"), hud = document.getElementById("vlHud");
    if (!el || !hud) return;
    posHud();
    el.textContent = type === "cmd" ? `✓ ${text}` : type === "interim" ? `${text}…` : text;
    hud.className = `vl-hud vl-hud-show vl-hud-${type}`;
    clearTimeout(hud._t);
    hud._t = setTimeout(() => { hud.className = "vl-hud"; },
      type === "cmd" ? 2000 : type === "interim" ? 3500 : 1800);
  }
  let pillResetTimer = null;
  function showInterimOnPill(text) {
    if (!overlay) return;
    if (state.loop.active) { showHud(`Heard: ${text}`, "interim"); return; }
    const lbl = $("#vlLabel"); if (!lbl) return;
    lbl.textContent = `"${text}"`;
    lbl.classList.add("vl-label-interim");
    clearTimeout(pillResetTimer);
    pillResetTimer = setTimeout(() => {
      lbl.classList.remove("vl-label-interim");
      lbl.textContent = state.listening ? "Listening" : "SetLoop";
    }, 1200);
  }
  function drag(el) {
    let d = false, sx, sy, ox, oy;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".vl-btn,.vl-edit-btn")) return;
      d = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      el.setPointerCapture(e.pointerId);
      el.style.transition = "none";
    });
    el.addEventListener("pointermove", (e) => {
      if (!d) return;
      el.style.position = "fixed";
      el.style.left = `${ox + e.clientX - sx}px`;
      el.style.top = `${oy + e.clientY - sy}px`;
      el.style.right = "auto"; el.style.bottom = "auto";
    });
    el.addEventListener("pointerup", () => { d = false; el.style.transition = ""; });
  }
  function setStatus(text, mode = "idle") {
    if (!overlay) return;
    const lbl = $("#vlLabel");
    if (mode === "loop" || mode === "paused" || mode === "mark" ||
        !lbl.classList.contains("vl-label-interim")) {
      lbl.textContent = text;
      lbl.classList.remove("vl-label-interim");
    }
    lbl.classList.toggle("vl-label-mark", mode === "mark");
    $("#vlDot").className = "vl-dot" + ({
      listening: " vl-dot-on", loop: " vl-dot-loop", success: " vl-dot-ok",
      error: " vl-dot-err", paused: " vl-dot-paused", mark: " vl-dot-mark",
    }[mode] || "");
    $("#vlPill").className = "vl-pill" + ({
      listening: " vl-pill-on", loop: " vl-pill-loop", paused: " vl-pill-paused",
      mark: " vl-pill-mark",
    }[mode] || "");
    const mic = $("#vlMic");
    mic.classList.remove("vl-btn-active", "vl-btn-paused");
    if (mode === "paused") mic.classList.add("vl-btn-paused");
    else if (state.listening || state.pttHeld) mic.classList.add("vl-btn-active");
    syncState();
  }
  function updateProgress() {
    if (!overlay) return;
    const b = $("#vlProgress");
    if (!state.loop.active) { b.style.width = "0"; return; }
    const v = getVideo(); if (!v) return;
    b.style.width = `${clamp((v.currentTime - state.loop.start) / (state.loop.end - state.loop.start), 0, 1) * 100}%`;
  }
  function toast(m, ms = TOAST_MS) {
    if (!overlay) return;
    const t = $("#vlToast"); t.textContent = m;
    t.classList.add("vl-toast-show");
    clearTimeout(toastTmr);
    toastTmr = setTimeout(() => t.classList.remove("vl-toast-show"), ms);
  }

  // ── Number + time helpers ─────────────────────────────────────────────

  const W = {
    zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
    ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,
    seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,
    sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,half:50,quarter:25,double:200,
  };
  function num(t) {
    const s = t.toLowerCase().trim();
    const n = parseFloat(s);
    if (!isNaN(n)) return n;
    const p = s.match(/^(.+?)\s+point\s+(.+)$/);
    if (p) {
      const a = num(p[1]), b = num(p[2]);
      if (!isNaN(a) && !isNaN(b)) return a + b / 10 ** Math.ceil(Math.log10(b + 1));
    }
    if (W[s] !== undefined) return W[s];
    let c = 0;
    for (const x of s.split(/[\s-]+/)) {
      const v = W[x];
      if (v === undefined) continue;
      if (v === 100) c = (c || 1) * 100;
      else c += v;
    }
    return c || NaN;
  }
  function parseTime(s) {
    s = s.trim();
    const c = s.match(/^(\d+):(\d+)$/);
    if (c) return +c[1] * 60 + +c[2];
    const m = s.match(/(\w+)\s+minutes?\s*(?:and\s+)?(\w+)?\s*(?:seconds?)?/i);
    if (m) { const v = num(m[1]); return isNaN(v) ? NaN : v * 60 + (m[2] ? (num(m[2]) || 0) : 0); }
    const o = s.match(/(\w+)\s+minutes?/i);
    if (o) { const v = num(o[1]); return isNaN(v) ? NaN : v * 60; }
    const z = s.match(/(\w+)\s*(?:seconds?|secs?)?$/i);
    if (z) { const v = num(z[1]); return isNaN(v) ? NaN : v; }
    return NaN;
  }

  // ── Normalize + parse ─────────────────────────────────────────────────

  // Tutorial/narrative words — transcripts containing any of these are
  // almost never voice commands and are aggressively rejected post-parse.
  // Real commands are short and imperative; narration isn't.
  const FILLER_REJECT = /\b(?:essentially|basically|actually|literally|obviously|i\s+mean|you\s+know|what\s+i\s+mean|by\s+that|in\s+other\s+words|so\s+what|kind\s+of|sort\s+of|gonna|going\s+to\s+be|what\s+if\s+you|a\s+little\s+bit|the\s+other\s+thing)\b/i;

  function normalize(raw) {
    // Phonetic pass — catches mishears not in the regex tables (e.g. SR
    // hears "loob" or "lewp" for "loop"). Gated to short utterances inside
    // the helper itself, so narration is untouched.
    const phon = phoneticRewrite(raw.toLowerCase());
    let t = " " + phon + " ";

    // Word-count gate for aggressive fuzzy rewrites. Real commands are
    // short and imperative ("loop last 30 at 50" = 5 words). Tutorial
    // narration is long. Rewriting "luke"→"loop" unconditionally eats
    // sentences like "Luke last year went to..."; gating on length keeps
    // the fuzzy power for commands while sparing narration.
    const wordCount = raw.trim().split(/\s+/).filter(Boolean).length;
    const shortUtterance = wordCount <= 6;

    if (shortUtterance) {
      // "loop" mishears — Chrome regularly hears the word "loop" as any of
      // these when said quickly into a laptop mic. Gated to short
      // utterances so long narratives don't get rewritten.
      t = t.replace(/\b(?:luke|lupe|loup|loops|lou|louie|louvre|lupin|lupa|roup|moop|blue|boot|who+p?)\b/g, "loop");
      t = t.replace(/\blook\b(?=\s+(?:last|stop|from|\d))/g, "loop");
    } else {
      // Even in long utterances keep the safe context-gated version —
      // "Luke last" at the start of a sentence is still probably a command.
      t = t.replace(/^(?:\s*)(?:luke|lupe|loup|lupin)\b(?=\s+(?:last|stop|from|\d))/g, "loop");
    }
    t = t.replace(/\bset\s+loop\b/g, "loop");
    t = t.replace(/\bdeath\s*loop\b/g, "loop");
    t = t.replace(/\bloops\b/g, "loop");

    // "last" mishears — only near numeric arguments
    t = t.replace(/\b(?:blast|class|glass)\b(?=\s+(?:\d|\w+\s+(?:at|for)))/g, "last");
    t = t.replace(/\blasts\b/g, "last");

    // Speed separator — "to"/"and"/"for" when clearly numeric. Only inside
    // a loop-last command so tutorial "25 to 10" doesn't get eaten.
    t = t.replace(/(\bloop\s+last\s+\d+)\s+(?:to|and|for)\s+(\d)/g, "$1 at $2");
    t = t.replace(/(\bloop\s+last\s+\w+)\s+(?:to|and|for)\s+(\w+)\s+(?:percent|%)/g, "$1 at $2 percent");
    // "loop last 20 34" (two bare numbers, no separator) — infer "at".
    // Safe: "loop last N M" is otherwise meaningless; "at" is the only
    // logical relationship between two numbers in this position.
    t = t.replace(/(\bloop\s+last\s+\d+)\s+(\d{1,3})(?=\s|$)/g, "$1 at $2");

    // Mark start/end — gate to short utterances so video narration like
    // "Mark Stark, the guitarist..." doesn't rewrite on a long interim.
    // Also support "mark in" / "mark out" (standard in/out-point terminology).
    if (shortUtterance) {
      // mark start mishears: "stark", "stars/star", "stir", "stare", "store", "starter(s)"
      // Chrome SR frequently confuses "start" with these when said quickly.
      t = t.replace(/\bmark\s+(?:stark|stars?|stir|stare|store|starter?s?)\b/g, "mark start");
      // mark stop aliases: "end", "out", "and", "n", "ned", "stops"
      // "stop" itself is handled directly in parse() as mark_end canonical trigger.
      t = t.replace(/\bmark\s+(?:and|n|ned|end|out|stops)\b/g, "mark stop");
    }

    // Stop — context-gated. "stop it" → "stop", but don't eat the word
    // alone (false-positive risk is handled separately by strict mode).
    t = t.replace(/\bstop\s+it\b/g, "stop");
    t = t.replace(/\bstopped\b/g, "stop");

    // Ramp
    t = t.replace(/\bramped\b/g, "ramp");

    // Trim / extend
    t = t.replace(/\b(?:trimmed|trims)\b/g, "trim");
    t = t.replace(/\b(?:extends|extended|stretch|stretches)\b/g, "extend");

    // Tighter / wider — broader mishear coverage. Common SR errors:
    //   tighter → titan, tightin, tieten, titen, tighten, tider
    //   wider   → widen, widner, weiden, weider, vider, widow, weider
    t = t.replace(/\b(?:titer|tyter|titan|tighten|tightin|tieten|titen|tider|tiger|tighta|tighto)\b/g, "tighter");
    t = t.replace(/\b(?:wyder|widen|widner|weiden|weider|vider|widow|wider1|whiter)\b/g, "wider");

    // Speed / faster / slower
    t = t.replace(/\b(?:sped|spd)\b/g, "speed");
    t = t.replace(/\bspeed\s*up\b/g, "faster");
    t = t.replace(/\bslow\s*down\b/g, "slower");

    // Number-word mishears — Chrome regularly butchers these. Gated to
    // short utterances so narration ("they ate dinner", "won the match")
    // is left alone. Only fires when the surrounding context already
    // looks like a command (preceded by trigger word OR followed by
    // unit like "seconds"/"percent"/"at"/"to").
    if (shortUtterance) {
      const N = (pre, mishears, canonical) =>
        new RegExp(`(${pre})\\b(?:${mishears})\\b`, "g");
      // Common digit-word mishears, only after trigger words
      const TRIGGER = "loop\\s+last\\s+|loop\\s+from\\s+|speed\\s+|back\\s+|forward\\s+|shift\\s+(?:back|forward)\\s+|wider\\s+|tighter\\s+|trim\\s+|extend\\s+|at\\s+|to\\s+|and\\s+|for\\s+";
      const POST = "(?=\\s|$)";
      // Build mishear → canonical pairs, applied as preceded-by-trigger rewrites
      const numFix = [
        [/\b(?:won|wun)\b/g, "one"],
        [/\b(?:tu|tew|too)\b(?=\s|$)/g, "two"],   // careful: "too" common word
        [/\btree\b/g, "three"],                    // careful: "tree" common word
        [/\b(?:fer|fore|fourty)\b/g, "four"],
        [/\bfivve\b/g, "five"],
        [/\bate\b/g, "eight"],
        [/\b(?:tin|tan)\b/g, "ten"],
        [/\bleven\b/g, "eleven"],
        [/\btwelv\b/g, "twelve"],
        [/\b(?:fiveteen|feefteen)\b/g, "fifteen"],
        [/\b(?:tweny|twenny|twinny|twentee)\b/g, "twenty"],
        [/\b(?:thurty|thirsty|dirty|birdie)\b/g, "thirty"],
        [/\b(?:fourty)\b/g, "forty"],
        [/\b(?:fivety|fiftee)\b/g, "fifty"],
        [/\bsixtee\b/g, "sixty"],
        [/\bseventee\b/g, "seventy"],
        [/\beightee\b/g, "eighty"],
        [/\b(?:ninty|ninetee)\b/g, "ninety"],
        [/\b(?:hunner|hunnerd|hundret|honored|hundered)\b/g, "hundred"],
        [/\bperfent\b/g, "percent"],
      ];
      // Apply each mishear ONLY after a trigger context, to avoid
      // touching "they ate dinner" / "won the match" in narration.
      for (const [pat, canon] of numFix) {
        t = t.replace(new RegExp(`(${TRIGGER})${pat.source}${POST}`, "g"),
          (m, pre) => `${pre}${canon}`);
        // Also catch the post-trigger position when a number is the FIRST
        // word after the trigger (most common form): "loop last ate" → "loop last eight"
        // Already covered above by the (TRIGGER)(mishear) form.
      }
    }

    return t.trim().replace(/\s+/g, " ");
  }

  function parse(raw) {
    // Filler-word guard: transcripts containing narrative markers are
    // almost certainly video audio, not commands.
    // Exception: if "loop" appears AFTER the filler word, the user
    // likely spoke a command at the end of a mixed transcript
    // (video narration bled into the SR window before the user spoke).
    // In that case, allow parsing — the loop_last regex will find the command.
    if (FILLER_REJECT.test(raw)) {
      const fillerPos = FILLER_REJECT.exec(raw)?.index ?? 0;
      const lastLoopIdx = raw.toLowerCase().lastIndexOf("loop");
      if (lastLoopIdx === -1 || lastLoopIdx <= fillerPos) return null;
      // "loop" after filler → user command follows narration, proceed
    }

    const t = normalize(raw).replace(/[.!,?]+/g, "").trim();
    if (!t) return null;

    const words = t.split(/\s+/).filter(Boolean);
    const hasLoopPrefix = /(?:^|\s)loop(?:\s|$)/.test(t);

    // Long-form loop commands ─────────────────────────────────────

    let m = t.match(/loop\s+last\s+([\w\s-]+?)\s+(?:at|and)\s+([\w\s-]+?)\s*(?:percent|%)?\s*(?:speed)?\s*(ramp(?:\s+up)?)?\s*$/);
    if (!m) m = t.match(/loop\s+last\s+(\w+)\s*(?:(?:at|and)\s+(\w+)\s*(?:percent|%)?\s*(?:speed)?)?\s*(ramp(?:\s+up)?)?/);
    if (m) {
      const s = parseTime(m[1]);
      if (!isNaN(s) && s > 0 && s < 600) {
        let spd = null;
        if (m[2]) { let v = num(m[2]); if (!isNaN(v)) { spd = v > 4 ? v / 100 : v; spd = clamp(spd, 0.1, 4); } }
        return { a: "loop_last", secs: s, spd, ramp: !!m[3] };
      }
    }

    m = t.match(/loop\s+(?:from\s+)?(\d+(?::\d+)?)\s+(?:to|at)\s+(\d+(?::\d+)?)(?:\s+(?:at|and)\s+(\w+)\s*(?:percent|%)?)?/);
    if (m && /:/.test(m[1] + m[2])) {
      const s = parseTime(m[1]), e = parseTime(m[2]);
      if (!isNaN(s) && !isNaN(e) && e > s) {
        let spd = null;
        if (m[3]) { let v = num(m[3]); if (!isNaN(v)) { spd = v > 4 ? v / 100 : v; spd = clamp(spd, 0.1, 4); } }
        return { a: "loop_range", start: s, end: e, spd };
      }
    }

    // Short commands ──────────────────────────────────────────────

    const STRICT_ALLOWLIST = /^(?:mark\s+(?:start|in)|mark\s+(?:stop|end|out)|mic\s+off|stop\s+listening|turn\s+off)$/;
    const stripped = t.replace(/^(?:.*\s)?loop\s+/, "").trim();

    if (words.length > 8) return null;

    const requirePrefix = state.strict && state.mode === "always";
    let cmd;
    if (requirePrefix) {
      if (STRICT_ALLOWLIST.test(t)) cmd = t;
      else if (hasLoopPrefix) cmd = stripped;
      else return null;
    } else {
      cmd = stripped || t;
    }

    if (/^mark\s+(?:start|in)$/.test(cmd) || /^mark\s+(?:start|in)$/.test(t)) return { a: "mark_start" };
    if (/^mark\s+(?:stop|end|out)$/.test(cmd) || /^mark\s+(?:stop|end|out)$/.test(t)) return { a: "mark_end" };

    if (/^(?:mic\s+off|stop\s+listening|turn\s+off)$/.test(cmd) ||
        /^(?:mic\s+off|stop\s+listening|turn\s+off)$/.test(t)) return { a: "mic_off" };

    if (/^(?:stop|cancel|end\s+loop|quit)(?:\s+loop(?:ing)?)?$/.test(cmd)) return { a: "stop" };

    // Adjust commands accept optional seconds: "wider 5", "trim 10", "shift back 3"
    m = cmd.match(/^wider(?:\s+(\w+))?$/);
    if (m) { const d = m[1] ? parseTime(m[1]) : 2; if (!isNaN(d) && d > 0) return { a: "adjust", startDelta: -d, endDelta: 0 }; }
    m = cmd.match(/^tighter(?:\s+(\w+))?$/);
    if (m) { const d = m[1] ? parseTime(m[1]) : 2; if (!isNaN(d) && d > 0) return { a: "adjust", startDelta: d, endDelta: 0 }; }
    m = cmd.match(/^trim(?:\s+(\w+))?$/);
    if (m) { const d = m[1] ? parseTime(m[1]) : 2; if (!isNaN(d) && d > 0) return { a: "adjust", startDelta: 0, endDelta: -d }; }
    m = cmd.match(/^extend(?:\s+(\w+))?$/);
    if (m) { const d = m[1] ? parseTime(m[1]) : 2; if (!isNaN(d) && d > 0) return { a: "adjust", startDelta: 0, endDelta: d }; }
    m = cmd.match(/^shift\s+back(?:\s+(\w+))?$/);
    if (m) { const d = m[1] ? parseTime(m[1]) : 2; if (!isNaN(d) && d > 0) return { a: "adjust", startDelta: -d, endDelta: -d }; }
    m = cmd.match(/^shift\s+forward(?:\s+(\w+))?$/);
    if (m) { const d = m[1] ? parseTime(m[1]) : 2; if (!isNaN(d) && d > 0) return { a: "adjust", startDelta: d, endDelta: d }; }

    if (/^ramp(?:\s+on)?$/.test(cmd)) return { a: "ramp", on: true };
    if (/^ramp\s+off$/.test(cmd))     return { a: "ramp", on: false };

    m = cmd.match(/^(?:set\s+)?speed\s+(?:to\s+)?(\w+)(?:\s*(?:percent|%))?$/);
    if (m) { let r = num(m[1]); if (isNaN(r)) return null; if (r > 4) r /= 100; return { a: "speed", rate: clamp(r, 0.1, 4) }; }
    if (/^(?:normal\s+speed|reset(?:\s+speed)?)$/.test(cmd)) return { a: "speed", rate: 1 };
    if (/^half(?:\s+speed)?$/.test(cmd)) return { a: "speed", rate: 0.5 };
    if (/^(?:slow(?:er)?)$/.test(cmd)) return { a: "nudge", d: -0.25 };
    if (/^(?:fast(?:er)?)$/.test(cmd)) return { a: "nudge", d: 0.25 };

    m = cmd.match(/^back\s+(\w+)$/);
    if (m) { const s = parseTime(m[1]); if (!isNaN(s)) return { a: "seek", d: -s }; }
    m = cmd.match(/^(?:forward|skip)\s+(\w+)$/);
    if (m) { const s = parseTime(m[1]); if (!isNaN(s)) return { a: "seek", d: s }; }

    if (/^pause$/.test(cmd)) return { a: "pause" };
    if (/^(?:play|resume)$/.test(cmd)) return { a: "play" };
    if (/^(?:bookmark|save(?:\s+here)?|save\s+this)$/.test(cmd)) return { a: "bookmark" };
    if (/^(?:copy|share)(?:\s*(?:link|url))?$/.test(cmd)) return { a: "copy" };

    return null;
  }

  // ── Command execution ─────────────────────────────────────────────────

  function exec(cmd) {
    if (cmd.a === "mic_off") {
      stopListening(); beep(); toast("Mic OFF"); showHud("Mic OFF", "info");
      return;
    }
    const v = getVideo();
    if (!v) { toast("No video found"); return; }
    beep();

    const refTime = state.speechStartTime != null ? state.speechStartTime : v.currentTime;

    switch (cmd.a) {
      case "loop_last": {
        stopLoop(v, false);
        state.loop.start = Math.max(0, refTime - cmd.secs);
        state.loop.end = refTime;
        state.loop.ramp = !!cmd.ramp;
        startLoop(v, cmd.spd);
        const l = cmd.spd ? `Loop ${cmd.secs}s @ ${Math.round(cmd.spd * 100)}%${cmd.ramp ? " ↑" : ""}`
                          : `Loop last ${cmd.secs}s`;
        toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break;
      }
      case "loop_range": {
        stopLoop(v, false);
        state.loop.start = cmd.start; state.loop.end = cmd.end;
        state.loop.ramp = false;
        startLoop(v, cmd.spd);
        const l = `Loop ${fmt(cmd.start)}–${fmt(cmd.end)}`;
        toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break;
      }
      case "mark_start": {
        // Use refTime (anchored to when the user spoke) not v.currentTime
        // (which is 1-2s late due to SR transcription latency).
        state.loop.markStart = refTime;
        const markLbl = `Mark: ${fmt(refTime)}`;
        setStatus(markLbl, "mark");
        toast(`${markLbl} set — say "mark stop"`);
        showHud(`${markLbl} · say "mark stop"`, "cmd"); break;
      }
      case "mark_end": {
        if (state.loop.markStart == null) {
          // No start set — most likely "mark start" was misheard as "mark stop"
          // by Chrome SR. Treat it as mark_start so the user doesn't have to repeat.
          state.loop.markStart = refTime;
          const markLbl = `Mark: ${fmt(refTime)}`;
          setStatus(markLbl, "mark");
          toast(`${markLbl} set — say "mark stop"`);
          showHud(`${markLbl} · say "mark stop"`, "cmd"); break;
        }
        const s = Math.min(state.loop.markStart, refTime);
        const e = Math.max(state.loop.markStart, refTime);
        if (e - s < 0.5) { toast("Loop too short"); state.loop.markStart = null; break; }
        state.loop.markStart = null;
        stopLoop(v, false);
        state.loop.start = s; state.loop.end = e;
        state.loop.ramp = false;
        startLoop(v, null);
        const l = `Loop ${fmt(s)}–${fmt(e)}`;
        toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break;
      }
      case "adjust": {
        if (!state.loop.active) { toast("No active loop"); return; }
        state.loop.start = Math.max(0, state.loop.start + cmd.startDelta);
        state.loop.end = Math.max(state.loop.start + 1, state.loop.end + cmd.endDelta);
        v.currentTime = state.loop.start;
        const l = loopLabel();
        toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break;
      }
      case "ramp": {
        if (!state.loop.active) { toast("No active loop"); return; }
        state.loop.ramp = !!cmd.on;
        toast(cmd.on ? "Ramp ON" : "Ramp OFF");
        setStatus(loopLabel(), "loop");
        showHud(cmd.on ? "Ramp ON" : "Ramp OFF", "cmd"); break;
      }
      case "stop": {
        const w = state.loop.active;
        stopLoop(v, true);
        lastFired = { sig: null, at: 0 }; // clear dedup so the same loop can re-fire immediately
        toast(w ? "Stopped" : "No loop");
        setStatus("Listening", state.listening ? "listening" : "idle");
        if (w) showHud("Stopped", "info"); break;
      }
      case "speed": {
        v.playbackRate = cmd.rate;
        const m = `Speed ${Math.round(cmd.rate * 100)}%`;
        toast(m); setStatus(state.loop.active ? loopLabel() : m, state.loop.active ? "loop" : "success");
        showHud(m, "cmd"); break;
      }
      case "nudge": {
        const r = clamp(Math.round((v.playbackRate + cmd.d) * 100) / 100, 0.25, 4);
        v.playbackRate = r;
        const m = `Speed ${Math.round(r * 100)}%`;
        toast(m); setStatus(state.loop.active ? loopLabel() : m, state.loop.active ? "loop" : "success");
        showHud(m, "cmd"); break;
      }
      case "seek": {
        v.currentTime = clamp(v.currentTime + cmd.d, 0, v.duration);
        const m = cmd.d < 0 ? `Back ${-cmd.d}s` : `Fwd ${cmd.d}s`;
        toast(m); showHud(m, "info"); break;
      }
      case "pause": v.pause(); toast("Paused"); setStatus("Paused", "idle"); showHud("Paused", "info"); break;
      case "play": v.play(); toast("Playing");
        setStatus(state.loop.active ? loopLabel() : "Playing", state.loop.active ? "loop" : "listening"); break;
      case "bookmark": addBm(); break;
      case "copy": copyText(tsUrl(v.currentTime)); toast("Link copied"); showHud("Link copied", "info"); break;
    }
    state.speechStartTime = null;
  }

  function loopLabel() {
    const v = getVideo();
    const spd = Math.round((v?.playbackRate || 1) * 100);
    const rampArrow = state.loop.ramp ? " ↑" : "";
    return `#${state.loop.count} · ${fmt(state.loop.start)}–${fmt(state.loop.end)} · ${spd}%${rampArrow}`;
  }

  function isAdPlaying() {
    try {
      if (document.querySelector(".html5-video-player.ad-showing")) return true;
      if (document.querySelector(".ytp-ad-player-overlay")) return true;
      if (document.querySelector(".ytp-ad-preview-container")) return true;
      if (document.querySelector(".ytm-ads-slot")) return true;
    } catch {}
    return false;
  }

  function startLoop(v, spd) {
    state.loop.preRate = v.playbackRate;
    if (spd) v.playbackRate = spd;
    state.loop.active = true;
    state.loop.count = 0;
    v.currentTime = state.loop.start;
    if (v.paused) v.play().catch(() => {});
    showTimeline();
    syncState();

    const check = () => {
      if (!state.loop.active) return;
      if (isAdPlaying()) return;
      updateProgress();
      updateTimeline();
      if (v.currentTime >= state.loop.end - 0.04 || v.currentTime < state.loop.start - 1) {
        wrapLoop(v);
      }
    };

    if (typeof v.requestVideoFrameCallback === "function") {
      const cb = () => {
        if (!state.loop.active) return;
        check();
        try { state.loop._rvfc = v.requestVideoFrameCallback(cb); } catch {}
      };
      try { state.loop._rvfc = v.requestVideoFrameCallback(cb); } catch {}
    }
    state.loop.interval = setInterval(check, 100);
  }

  function wrapLoop(v) {
    const vol = v.volume;
    v.volume = Math.max(0, vol - 0.3);
    v.currentTime = state.loop.start;
    setTimeout(() => { v.volume = vol; }, 15);
    state.loop.count++;
    if (state.loop.ramp) {
      const r = clamp(v.playbackRate + RAMP_STEP, 0.1, 4);
      v.playbackRate = r;
      if (r >= 1) state.loop.ramp = false;
    }
    setStatus(loopLabel(), "loop");
  }

  function stopLoop(v, restore) {
    state.loop.active = false;
    state.loop.ramp = false;
    state.loop.markStart = null;
    if (state.loop.interval) { clearInterval(state.loop.interval); state.loop.interval = null; }
    state.loop._rvfc = null;
    if (restore && v) v.playbackRate = state.loop.preRate;
    state.loop.preRate = 1;
    state.loop.count = 0;
    updateProgress();
    hideTimeline();
    syncState();
  }

  // ── Loop Timeline ─────────────────────────────────────────────────────

  // Returns the time window the timeline track represents.
  // Zooms in around the active loop so short clips (10-30s) get wide handles.
  // Padding = 1.5× loop duration, clamped to 10–60s either side.
  function getTimelineWindow(v) {
    if (!state.loop.active || !v || !v.duration) return null;
    const loopDur = Math.max(state.loop.end - state.loop.start, 1);
    const pad = clamp(loopDur * 1.5, 10, 60);
    return {
      start: Math.max(0, state.loop.start - pad),
      end: Math.min(v.duration, state.loop.end + pad),
    };
  }

  function updateTimeline() {
    const tl = $("#vlTl"); if (!tl || tl.hidden) return;
    const v = getVideo(); if (!v || !v.duration) return;
    // Use zoomed window so short loops get widely-spaced handles.
    const win = getTimelineWindow(v) || { start: 0, end: v.duration };
    const winDur = Math.max(win.end - win.start, 0.1);
    const ls = clamp((state.loop.start - win.start) / winDur, 0, 1);
    const le = clamp((state.loop.end   - win.start) / winDur, 0, 1);
    const ct = clamp((v.currentTime   - win.start) / winDur, 0, 1);
    const loop = $("#vlTlLoop");
    const hs   = $("#vlTlHs");
    const he   = $("#vlTlHe");
    const head = $("#vlTlHead");
    const lsEl = $("#vlTlLs");
    const leEl = $("#vlTlLe");
    if (loop) { loop.style.left = `${ls * 100}%`; loop.style.width = `${(le - ls) * 100}%`; }
    if (hs) hs.style.left = `${ls * 100}%`;
    if (he) he.style.left = `${le * 100}%`;
    if (head) head.style.left = `${ct * 100}%`;
    if (lsEl) lsEl.textContent = fmt(state.loop.start);
    if (leEl) leEl.textContent = fmt(state.loop.end);
  }

  function showTimeline() {
    const tl = $("#vlTl"); if (!tl) return;
    tl.hidden = false;
    updateTimeline();
    if (!tl._dragInit) { initTimelineDrag(); tl._dragInit = true; }
  }

  function hideTimeline() {
    const tl = $("#vlTl"); if (!tl) return;
    tl.hidden = true;
  }

  function initTimelineDrag() {
    const track  = $("#vlTlTrack");
    const hs     = $("#vlTlHs");
    const he     = $("#vlTlHe");
    const loopEl = $("#vlTlLoop");
    if (!track) return;

    // Convert clientX → video timestamp within the (frozen) zoomed window.
    function timeAtX(clientX, frozenWin, v) {
      const r = track.getBoundingClientRect();
      const frac = clamp((clientX - r.left) / r.width, 0, 1);
      if (frozenWin) return frozenWin.start + frac * (frozenWin.end - frozenWin.start);
      return frac * (v?.duration || 0);
    }

    // ── Handle drag — moves one endpoint, preserving the other ──────────
    function makeDrag(handle, isStart) {
      if (!handle) return;
      handle.addEventListener("mousedown", (e) => {
        e.stopPropagation(); e.preventDefault();
        const v = getVideo();
        const frozenWin = (v && state.loop.active) ? getTimelineWindow(v) : null;
        const onMove = (ev) => {
          const v = getVideo(); if (!v || !v.duration) return;
          const t = timeAtX(ev.clientX, frozenWin, v);
          if (isStart) {
            state.loop.start = clamp(t, 0, state.loop.end - 0.5);
            v.currentTime = state.loop.start;
          } else {
            state.loop.end = clamp(t, state.loop.start + 0.5, v.duration);
          }
          updateTimeline();
          setStatus(loopLabel(), "loop");
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }, { passive: false });
    }

    // ── Loop-bar drag — shifts the whole loop, keeping duration intact ───
    function makeShiftDrag(el) {
      if (!el) return;
      el.addEventListener("mousedown", (e) => {
        e.stopPropagation(); e.preventDefault();
        const v = getVideo(); if (!v || !v.duration) return;
        // Freeze window and snapshot loop at drag-start.
        const frozenWin   = state.loop.active ? getTimelineWindow(v) : null;
        const originTime  = timeAtX(e.clientX, frozenWin, v);
        const originStart = state.loop.start;
        const dur         = state.loop.end - state.loop.start; // preserve duration
        const onMove = (ev) => {
          const v = getVideo(); if (!v || !v.duration) return;
          const delta    = timeAtX(ev.clientX, frozenWin, v) - originTime;
          const newStart = clamp(originStart + delta, 0, v.duration - dur);
          state.loop.start = newStart;
          state.loop.end   = newStart + dur;
          v.currentTime    = state.loop.start;
          updateTimeline();
          setStatus(loopLabel(), "loop");
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      }, { passive: false });
    }

    makeDrag(hs, true);
    makeDrag(he, false);
    makeShiftDrag(loopEl);

    // Track click seeks — but not when the target is a handle or the loop bar.
    track.addEventListener("click", (e) => {
      if (e.target === hs || e.target === he || e.target === loopEl) return;
      const v = getVideo(); if (!v || !v.duration) return;
      const win = state.loop.active ? getTimelineWindow(v) : null;
      v.currentTime = timeAtX(e.clientX, win, v);
    });
  }

  // ── Dual-source audio monitor (mic + video reference) ───────────────
  //
  // SR captures audio internally and gives us no level access, so we run
  // a parallel mic stream AND a reference stream tapped from the video
  // element via HTMLMediaElement.captureStream(). With both signals we
  // can ask "is the mic louder than the speakers right now?" — which is
  // the actual question for speaker-bleed gating. The signals only feed
  // the bleed counter, the speech-duck trigger, and the missed-command
  // flash; they never block SR results, so a monitor failure (DRM video,
  // codec quirk) just means we fail open to today's behavior.
  //
  // Recovery: track 'ended' on either stream nulls its analyser and the
  // poll loop reattaches on the next tick. Mic stream loss restarts the
  // whole monitor after 500ms while SR keeps running.

  let micStream = null;
  let monitorCtx = null;
  let micAnalyser = null;
  let videoAnalyser = null;
  let videoStreamRef = null;
  let pollTimer = null;
  let micRestartTimer = null;
  let micRMS = 0;
  let videoRMS = 0;
  let noiseFloorSamples = [];
  let monitorOn = false;

  async function startAudioMonitor() {
    if (monitorOn) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        // autoGainControl off: we want raw mic energy for bleed comparison.
        // Chrome's SR pipeline runs its own AGC on its own internal stream.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      monitorCtx = new (window.AudioContext || window.webkitAudioContext)();
      const micSrc = monitorCtx.createMediaStreamSource(micStream);
      micAnalyser = monitorCtx.createAnalyser();
      micAnalyser.fftSize = 1024;
      micSrc.connect(micAnalyser);

      micStream.getAudioTracks()[0]?.addEventListener("ended", onMicTrackEnded);

      attachVideoMonitor();

      pollTimer = setInterval(samplePoll, AUDIO_POLL_MS);
      monitorOn = true;
      log("audio monitor started");
    } catch (e) {
      log("audio monitor failed:", e.name, e.message);
      stopAudioMonitor();
    }
  }

  function onMicTrackEnded() {
    log("mic track ended — restarting monitor");
    stopAudioMonitor();
    if (!state.listening) return;
    clearTimeout(micRestartTimer);
    micRestartTimer = setTimeout(() => {
      if (state.listening) startAudioMonitor();
    }, 500);
  }

  function attachVideoMonitor() {
    if (videoAnalyser || !monitorCtx) return false;
    const v = getVideo();
    if (!v || typeof v.captureStream !== "function") return false;
    try {
      videoStreamRef = v.captureStream();
      const tracks = videoStreamRef.getAudioTracks();
      if (!tracks.length) { videoStreamRef = null; return false; }
      const vSrc = monitorCtx.createMediaStreamSource(videoStreamRef);
      const a = monitorCtx.createAnalyser();
      a.fftSize = 1024;
      vSrc.connect(a);
      videoAnalyser = a;
      tracks[0].addEventListener("ended", () => {
        try { vSrc.disconnect(); } catch {}
        videoAnalyser = null;
        videoStreamRef = null;
      });
      log("video reference attached");
      return true;
    } catch (e) {
      log("video capture failed:", e.name);
      videoStreamRef = null;
      videoAnalyser = null;
      return false;
    }
  }

  function rmsOf(analyser) {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = (buf[i] - 128) / 128;
      sum += s * s;
    }
    return Math.sqrt(sum / buf.length);
  }

  function samplePoll() {
    micRMS = rmsOf(micAnalyser);
    videoRMS = rmsOf(videoAnalyser);

    // Reattach video reference if it dropped (ad transition, SPA nav, source switch).
    if (!videoAnalyser) attachVideoMonitor();

    // Track ambient floor only when both sources are quiet — this is true silence.
    if (micRMS < 0.02 && videoRMS < 0.005) {
      noiseFloorSamples.push(micRMS);
      if (noiseFloorSamples.length > NOISE_FLOOR_WINDOW) noiseFloorSamples.shift();
    }
  }

  function noiseFloor() {
    if (noiseFloorSamples.length < 5) return 0.005;
    const sorted = [...noiseFloorSamples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0.005;
  }

  // True when the mic is hearing something clearly above ambient and
  // not just speaker bleed. Fail-open if monitor isn't running.
  function isUserVoice() {
    if (!monitorOn) return true;
    const floor = noiseFloor();
    return micRMS > floor * VOICE_FLOOR_FACTOR &&
           (videoRMS === 0 || micRMS > videoRMS * VIDEO_BLEED_FACTOR);
  }

  // Speakers are currently producing audible output.
  function videoIsLoud() {
    return videoRMS > VIDEO_LOUD_RMS;
  }

  function stopAudioMonitor() {
    monitorOn = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (micRestartTimer) { clearTimeout(micRestartTimer); micRestartTimer = null; }
    if (micAnalyser) { try { micAnalyser.disconnect(); } catch {} micAnalyser = null; }
    if (videoAnalyser) { try { videoAnalyser.disconnect(); } catch {} videoAnalyser = null; }
    if (monitorCtx) { try { monitorCtx.close(); } catch {} monitorCtx = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (videoStreamRef) { videoStreamRef.getTracks().forEach(t => t.stop()); videoStreamRef = null; }
    micRMS = 0; videoRMS = 0;
    noiseFloorSamples = [];
  }

  // ── Phonetic matching (simplified Double Metaphone for trigger words) ─
  //
  // Adds a fallback layer to the existing mishear lists in normalize().
  // For short utterances, computes a phonetic code for each word and
  // checks if any maps to a known trigger ("loop", "stop", "ramp", etc.).
  // Catches mishears that aren't in the curated regex tables yet.

  function metaphone(word) {
    if (!word) return "";
    let s = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!s) return "";
    // Drop silent letters at start
    s = s.replace(/^(kn|gn|pn|wr|ps)/, (m) => m[1]);
    s = s.replace(/^x/, "s");
    let out = "";
    let prev = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const next = s[i + 1] || "";
      // Skip duplicates (except 'c')
      if (c === prev && c !== "c") continue;
      prev = c;
      switch (c) {
        case "a": case "e": case "i": case "o": case "u":
          if (i === 0) out += c; break;
        case "b": out += (i === s.length - 1 && s[i - 1] === "m") ? "" : "b"; break;
        case "c":
          if (next === "h") { out += "x"; i++; }
          else if (/[eiy]/.test(next)) out += "s";
          else out += "k";
          break;
        case "d":
          if (next === "g" && /[eiy]/.test(s[i + 2])) { out += "j"; i += 2; }
          else out += "t";
          break;
        case "g":
          if (next === "h" && !/[aeiou]/.test(s[i + 2] || "")) { i++; break; }
          if (next === "n") { out += "n"; i++; break; }
          out += /[eiy]/.test(next) ? "j" : "k";
          break;
        case "h":
          if (i > 0 && !/[aeiou]/.test(s[i - 1])) break;
          if (!/[aeiou]/.test(next)) break;
          out += "h"; break;
        case "k": if (s[i - 1] !== "c") out += "k"; break;
        case "p": if (next === "h") { out += "f"; i++; } else out += "p"; break;
        case "q": out += "k"; break;
        case "s":
          if (next === "h") { out += "x"; i++; }
          else if (next === "i" && /[ao]/.test(s[i + 2] || "")) out += "x";
          else out += "s";
          break;
        case "t":
          if (next === "h") { out += "0"; i++; }
          else if (next === "i" && /[ao]/.test(s[i + 2] || "")) out += "x";
          else out += "t";
          break;
        case "v": out += "f"; break;
        case "w": case "y": if (/[aeiou]/.test(next)) out += c; break;
        case "x": out += "ks"; break;
        case "z": out += "s"; break;
        default: out += c;
      }
    }
    return out;
  }

  // Pre-computed codes for our trigger words. Anything that hashes to one
  // of these in a short utterance gets rewritten to the canonical form.
  const PHONETIC_TRIGGERS = (() => {
    const m = new Map();
    const triggers = ["loop", "stop", "ramp", "wider", "tighter", "trim",
                      "extend", "faster", "slower", "speed", "back", "forward",
                      "bookmark", "mark", "start", "end", "pause", "play",
                      "shift", "copy", "link", "mic", "off", "last", "percent"];
    for (const t of triggers) {
      const code = metaphone(t);
      if (code && !m.has(code)) m.set(code, t);
    }
    return m;
  })();

  // Levenshtein distance between two short strings. Bounded — returns
  // Infinity if distance exceeds maxDist (early-out for speed).
  function editDistance(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return Infinity;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > maxDist) return Infinity;
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  function phoneticRewrite(text) {
    // Only operate on short utterances — narration shouldn't get touched.
    const words = text.split(/\s+/);
    if (words.length > 6) return text;
    let changed = false;
    const out = words.map((w) => {
      const clean = w.replace(/[^a-zA-Z]/g, "");
      if (!clean || clean.length < 3) return w;
      const code = metaphone(clean);
      if (!code) return w;
      // Skip if already a canonical trigger
      if (PHONETIC_TRIGGERS.has(code) && PHONETIC_TRIGGERS.get(code) === clean.toLowerCase()) return w;
      // Direct phonetic-code match
      let canon = PHONETIC_TRIGGERS.get(code);
      // Fallback: edit-distance-1 match on phonetic codes. Catches mishears
      // like "titan" (ttn) → "tighter" (ttr), "widen" (wtn) → "wider" (wtr).
      if (!canon) {
        for (const [tCode, tWord] of PHONETIC_TRIGGERS) {
          if (editDistance(code, tCode, 1) <= 1 &&
              editDistance(clean.toLowerCase(), tWord, 3) <= 3) {
            canon = tWord;
            break;
          }
        }
      }
      if (!canon) return w;
      // Final length-difference cap
      if (Math.abs(clean.length - canon.length) > 3) return w;
      changed = true;
      return canon;
    });
    return changed ? out.join(" ") : text;
  }

  // ── Bleed detector ────────────────────────────────────────────────────

  const bleed = {
    nonFiringFinals: [],
    warned: false,
    note(fired) {
      if (fired) { this.nonFiringFinals = []; return; }
      // Only count a non-firing final as bleed if speakers were actually audible
      // when SR captured it. Otherwise the user just mumbled — not bleed.
      // Fail-open (count anyway) when the monitor isn't running.
      if (monitorOn && !videoIsLoud()) return;
      const now = performance.now();
      this.nonFiringFinals.push(now);
      this.nonFiringFinals = this.nonFiringFinals.filter((t) => now - t < BLEED_WINDOW_MS);
      if (!this.warned &&
          this.nonFiringFinals.length >= BLEED_NONFIRE_MIN &&
          state.mode !== "ptt") {
        this.warned = true;
        bleedToast();
      }
    },
    reset() { this.nonFiringFinals = []; this.warned = false; },
  };

  function bleedToast() {
    if (!state.duck) {
      // Auto-duck not on yet — try that first, it's less disruptive than PTT
      showTip(
        "Mic is picking up speaker audio.",
        "Enable Auto-duck",
        () => {
          state.duck = true;
          saveCfg();
          duckVideo();
          syncState();
          toast("Auto-duck ON — video quieted while listening");
          hideTip();
        },
      );
    } else {
      // Already ducking but still getting bleed — PTT is the reliable fix
      showTip(
        "Still getting speaker bleed. Hold-to-talk eliminates it.",
        "Switch to Push-to-Talk",
        switchToPtt,
      );
    }
  }

  function switchToPtt() {
    if (state.mode === "ptt") return;
    state.mode = "ptt";
    saveCfg();
    if (state.listening) {
      stopSR();
      setStatus("Hold ` to speak", "idle");
    }
    syncState();
    toast("Mode: Push-to-Talk");
  }

  // Persistent inline tip below the pill. Less intrusive than a toast,
  // dismissable, with one optional action button. Used for the bleed warning
  // and any future hint we want to surface in-overlay.
  function showTip(text, actionLabel, actionFn) {
    if (!overlay) return;
    const tip = $("#vlTip");
    const txt = $("#vlTipText");
    const btn = $("#vlTipAction");
    const dis = $("#vlTipDismiss");
    if (!tip || !txt || !btn || !dis) return;
    txt.textContent = text;
    if (actionLabel && actionFn) {
      btn.textContent = actionLabel;
      btn.hidden = false;
      btn.onclick = (e) => { e.stopPropagation(); actionFn(); hideTip(); };
    } else {
      btn.hidden = true;
    }
    dis.onclick = (e) => { e.stopPropagation(); hideTip(); };
    tip.hidden = false;
  }
  function hideTip() {
    const tip = overlay && $("#vlTip");
    if (tip) tip.hidden = true;
  }

  // ── SpeechRecognition host ────────────────────────────────────────────

  let recog = null;
  let recogGen = 0;
  let recogActive = false;
  let restartTimer = null;
  let lastResultAt = 0;
  let lastSpeechStartAt = 0;  // SR's onspeechstart timestamp (real stall signal)
  let srStartedAt = 0;        // timestamp of last successful start (for pre-emptive recycle)
  let lastActivityAt = 0;     // set ONLY by onspeechstart or onresult — never by onstart
  let healthTimer = null;
  let speechDuckActive = false; // aggressive video-duck while user is speaking

  let lastInterim = "";
  // Once per utterance, when "loop" first appears in the interim, we refine
  // speechStartTime to video.currentTime - SR_INTERIM_LAG. Interim arrives
  // ~350-500ms after the word was spoken; this gives a tighter "when did
  // the user say loop" estimate than onspeechstart, which fires on any
  // audio (including bleed) and can be 1-2s too early.
  const SR_INTERIM_LAG = 0.45;
  let speechTimeRefined = false;
  let lastFired = { sig: null, at: 0 };
  // Stable-interim tracker: a parameterized command (e.g. "loop last 20 at 35")
  // must produce the same parse on two consecutive interim ticks before we'll
  // fire on interim. Cuts ~1–1.5s of perceived latency off args-based commands
  // without firing on partial args, because the parse has to actually stabilize.
  let stableInterim = { sig: null, at: 0 };
  function resetStableInterim() { stableInterim = { sig: null, at: 0 }; }

  const INTERIM_EAGER = new Set([
    "stop", "mic_off", "pause", "play", "bookmark", "copy",
    "nudge", "ramp",
    // "adjust" removed: "loop wider 10" gives interim "loop wider" (fires -2s)
    // then final "loop wider 10" (fires -10s) = -12s total. Not in INTERIM_EAGER
    // means we wait for the full final so the amount is always correct.
    // mark_start/mark_end also absent — same interim false-fire risk.
  ]);

  function cmdSignature(cmd) {
    switch (cmd.a) {
      case "loop_last":  return `ll:${cmd.secs}:${cmd.spd ?? ""}:${cmd.ramp ? 1 : 0}`;
      case "loop_range": return `lr:${cmd.start}:${cmd.end}:${cmd.spd ?? ""}`;
      case "adjust":     return `aj:${cmd.startDelta}:${cmd.endDelta}`;
      case "stop":       return "stop";
      case "mic_off":    return "micoff";
      case "speed":      return `sp:${cmd.rate}`;
      case "nudge":      return `nu:${cmd.d}`;
      case "seek":       return `sk:${cmd.d}`;
      case "pause":      return "pause";
      case "play":       return "play";
      case "bookmark":   return "bm";
      case "copy":       return "copy";
      case "mark_start": return "ms";
      case "mark_end":   return "me";
      case "ramp":       return `rp:${cmd.on ? 1 : 0}`;
      default:           return JSON.stringify(cmd);
    }
  }

  // Pick the best alternative for a single SR result. Prefers alt[0] when
  // it parses; otherwise scans alt[1..] and picks the first that does.
  // Falls back to alt[0] (or first non-empty) so non-command text still
  // reaches the UI for interim display and bleed accounting.
  function pickBestAlt(res) {
    let fallback = null;
    for (let j = 0; j < res.length; j++) {
      const alt = res[j];
      const text = alt?.transcript?.trim();
      if (!text) continue;
      const conf = typeof alt.confidence === "number" && alt.confidence > 0
        ? alt.confidence : null;
      if (!fallback) fallback = { text, conf };
      let parsed = null;
      try { parsed = parse(text); } catch {}
      if (parsed) {
        if (j > 0) log(`alt[${j}] parsed where alt[0] did not:`, text);
        return { text, conf };
      }
    }
    return fallback;
  }

  // A parameterized command is "ready" to fire on stable interim only when
  // every argument it can take is already filled — so a later word can't
  // change the parse. For loop_last that means an explicit speed; ramp can
  // arrive later, so we hold for stability if ramp wasn't said.
  function isInterimReady(cmd) {
    if (cmd.a === "loop_last") return cmd.spd != null;
    if (cmd.a === "loop_range") return cmd.spd != null;
    return false;
  }

  function tryFire(text, confidence, isFinal) {
    let cmd;
    try { cmd = parse(text); } catch (e) { log("parse threw:", e.message); cmd = null; }
    if (!cmd) return false;

    const sig = cmdSignature(cmd);
    const now = performance.now();

    // Interim gating — three tiers:
    //   1. INTERIM_EAGER short commands → fire on first parse (existing).
    //   2. Parameterized commands with all args present → require the same
    //      parse on consecutive interim ticks (STABLE_INTERIM_MS) before fire.
    //   3. Anything else → wait for final.
    if (!isFinal) {
      if (state.strict && confidence != null && confidence < 0.65) return false;
      const eager = INTERIM_EAGER.has(cmd.a);
      const ready = isInterimReady(cmd);
      if (!eager && !ready) return false;
      if (!eager && ready) {
        if (stableInterim.sig !== sig) {
          stableInterim = { sig, at: now };
          return false;
        }
        if ((now - stableInterim.at) < STABLE_INTERIM_MS) return false;
      }
    }

    // Dedup stamps the time so any follow-up interim/final with the same
    // signature within FIRE_DEDUP_MS is silently swallowed.
    if (sig === lastFired.sig && (now - lastFired.at) < FIRE_DEDUP_MS) {
      lastFired.at = now;
      return true;
    }
    lastFired = { sig, at: now };
    resetStableInterim();
    const firePath = isFinal ? "final" : INTERIM_EAGER.has(cmd.a) ? "interim-eager" : "interim-stable";
    log(`fire (${firePath}, conf=${confidence}):`, text, "→", cmd);
    if (overlay) $("#vlDot").classList.remove("vl-dot-hearing", "vl-dot-processing");
    exec(cmd);
    // Force-finalise on interim fires: calling stop() pushes Chrome to emit
    // the final immediately and restart clean. Covers both eager and
    // stable-interim paths.
    if (!isFinal && recogActive) {
      try { recog?.stop(); } catch {}
    }
    return true;
  }

  // Trigger words that strongly indicate the user is mid-command.
  // Used to gate (a) the blue interim pill display, (b) auto-duck activation.
  // Avoids reacting to pure video bleed like "It's a nice thing when…".
  const COMMAND_TRIGGER = /\b(loop|stop|mark|ramp|bookmark|copy|pause|play|mic|wider|tighter|trim|extend|shift|speed|faster|slower|cancel|quit)\b/i;

  function looksLikeCommand(text) {
    return COMMAND_TRIGGER.test(text);
  }

  function handleResult(text, isFinal, confidence) {
    if (isFinal) {
      log("final:", text, "conf=", confidence);
      resetStableInterim();
      speechTimeRefined = false;
      const fired = tryFire(text, confidence, true);
      bleed.note(fired);
      // Restore video volume on final (whether fired or not — speech is over)
      speechDuckOff();

      if (!fired && overlay) {
        state.speechStartTime = null;
        // Skip the red miss-flash when the transcript was almost certainly
        // speaker bleed — flashing red while a video plays trains users to
        // distrust the indicator. Only flash when the user actually spoke.
        const wasBleed = monitorOn && videoIsLoud() && !isUserVoice();
        if (!wasBleed) {
          const dot = $("#vlDot");
          if (dot) {
            dot.classList.remove("vl-dot-hearing", "vl-dot-processing");
            dot.classList.add("vl-dot-miss");
            setTimeout(() => $("#vlDot")?.classList.remove("vl-dot-miss"), 800);
          }
        }
      }
      lastInterim = "";
    } else {
      if (text === lastInterim) return;
      lastInterim = text;

      // Refine the loop reference time when "loop" first appears in the
      // interim. onspeechstart fires on any audio (bleed can trigger it
      // 1-2s early); this anchors refTime to the actual command word.
      if (!speechTimeRefined && /\b(?:loop|mark)\b/i.test(text)) {
        const v = getVideo();
        if (v) {
          const refined = Math.max(0, v.currentTime - SR_INTERIM_LAG);
          // Only move the reference forward — onspeechstart gave us a
          // floor; the interim can't have happened before speech started.
          if (state.speechStartTime == null || refined > state.speechStartTime) {
            state.speechStartTime = refined;
          }
          speechTimeRefined = true;
        }
      }

      // Only surface interim text in the UI if it contains a trigger word.
      // Tutorial narration ("It's a nice thing when…") is suppressed.
      if (looksLikeCommand(text)) {
        showInterimOnPill(text);
        // Duck only when this looks like real user voice — not bleed of a
        // narrator who happened to say "loop". isUserVoice fails open if
        // the monitor isn't running, preserving today's behavior.
        if (isUserVoice()) speechDuckOn();
      }
      tryFire(text, confidence, false);
    }
  }

  function buildRecogniser() {
    const r = new SR();
    r.lang = "en-US";
    r.continuous = state.mode === "always";
    r.interimResults = true;
    // Ask Chrome for 4 alternatives. When alt[0] is mangled, alt[1..3]
    // often contains the actual command — we parse each and pick the first
    // that matches our grammar. Pure win for catching commands; never causes
    // a false fire because every alt still goes through parse() + dedup.
    r.maxAlternatives = 4;
    // NOTE: Chrome 138+ has experimental r.processLocally for on-device SR,
    // but setting it without first awaiting SR.available({langs, processLocally})
    // throws "language-not-supported" on start. Skipping until we add the
    // async availability probe; cloud SR is the safe default and works
    // identically from this code's perspective.

    const myGen = ++recogGen;

    r.onstart = () => {
      if (myGen !== recogGen) return;
      recogActive = true;
      lastResultAt = performance.now();
      srStartedAt = performance.now();
      lastActivityAt = 0; // reset per-instance; onspeechstart/onresult will set it
      log("SR onstart");
      if (state.listening) {
        setStatus(state.mode === "ptt" && !state.pttHeld ? "Hold ` to speak" : "Listening",
                  state.mode === "ptt" && !state.pttHeld ? "idle" : "listening");
        // One-time "SR is actually alive" confirmation after user toggles on.
        // Subsequent recycling restarts don't show this — just the green dot.
        if (!srConfirmed) {
          srConfirmed = true;
          showHud(state.mode === "ptt" ? "Ready — hold ` to speak" : "Ready ✓ — speak a command", "cmd");
        }
      }
    };

    r.onend = () => {
      if (myGen !== recogGen) return;
      recogActive = false;
      log("SR onend");
      if (!state.listening) return;
      if (state.mode === "ptt" && !state.pttHeld) return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!state.listening) return;
        if (state.mode === "ptt" && !state.pttHeld) return;
        startSR();
      }, 120);
    };

    r.onerror = (e) => {
      if (myGen !== recogGen) return;
      log("SR onerror:", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        recogActive = false; recog = null; recogGen++;
        state.listening = false;
        setStatus("Mic blocked on this site", "error");
        toast("Allow mic (address-bar icon) then toggle again");
        syncState();
      } else if (e.error === "network") {
        setStatus("No internet", "error");
        toast("Voice needs an internet connection");
      } else if (e.error === "language-not-supported" || e.error === "bad-grammar") {
        recogActive = false; recog = null; recogGen++;
        // Tear down the audio monitor too — leaving it on with no SR
        // means a useless mic stream and noise-floor accumulation.
        stopAudioMonitor();
        state.listening = false;
        setStatus("Voice unavailable here", "error");
        toast("Voice unavailable on this page");
        syncState();
      }
      // "no-speech" / "audio-capture" / "aborted" — routine; onend restarts.
    };

    r.onresult = (e) => {
      if (myGen !== recogGen) return;
      lastResultAt = performance.now();
      lastActivityAt = performance.now();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const best = pickBestAlt(res);
        if (best) handleResult(best.text, res.isFinal, best.conf);
      }
    };

    r.onspeechstart = () => {
      if (myGen !== recogGen) return;
      state.speaking = true;
      lastSpeechStartAt = performance.now();
      lastActivityAt = performance.now();
      // Duck the video immediately when the dual-source monitor confirms it's
      // the user's voice, not speaker bleed. This gives SR a cleaner audio
      // window for the rest of the command, reducing narration prefix pollution.
      // isUserVoice() fails open (returns false) when monitor isn't running,
      // preserving the old "duck only on trigger word" path as fallback.
      if (isUserVoice()) speechDuckOn();
      const v = getVideo();
      state.speechStartTime = v ? Math.max(0, v.currentTime - 0.3) : null;
      if (overlay) {
        const d = $("#vlDot");
        if (d) { d.classList.remove("vl-dot-processing", "vl-dot-miss"); d.classList.add("vl-dot-hearing"); }
      }
    };
    r.onspeechend = () => {
      if (myGen !== recogGen) return;
      state.speaking = false;
      // speechDuckOff handled by handleResult timeout — onspeechend fires
      // for any audio drop, including video pauses.
      if (overlay) {
        const d = $("#vlDot");
        if (d) { d.classList.remove("vl-dot-hearing"); d.classList.add("vl-dot-processing"); setTimeout(() => d?.classList.remove("vl-dot-processing"), 1200); }
      }
    };

    return r;
  }

  function startSR() {
    if (!SR) {
      setStatus("Voice not supported", "error");
      toast("SpeechRecognition not available in this browser");
      state.listening = false;
      syncState();
      return;
    }
    if (recogActive) return;
    recog = buildRecogniser();
    try { recog.start(); }
    catch (e) {
      log("r.start() threw:", e.name, e.message);
      if (e.name === "InvalidStateError") {
        // Chrome thinks SR is already running (stale internal state after rapid
        // start/stop cycles). Abort the ghost instance and retry clean.
        log("InvalidStateError — aborting stale SR and retrying");
        try { recog?.abort(); } catch {}
        recog = null; recogActive = false;
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => { if (state.listening) startSR(); }, 250);
        return;
      }
      setStatus("Voice error — retry", "error");
      toast(e.message || "Could not start voice");
      state.listening = false; recogActive = false; recog = null;
      syncState();
    }
  }

  function stopSR() {
    clearTimeout(restartTimer); restartTimer = null;
    recogGen++;
    recogActive = false;
    if (recog) { try { recog.abort(); } catch {} recog = null; }
  }

  // ── Listening toggle ────────────────────────────────────────────────

  let srConfirmed = false; // true after the first onstart following a user-initiated toggle

  function startListening() {
    state.listening = true;
    srConfirmed = false;
    bleed.reset();
    setStatus("Starting…", "paused");
    syncState();
    if (state.mode !== "ptt") startSR();
    else setStatus("Hold ` to speak", "paused");
    if (state.duck) duckVideo();
    startAudioMonitor();

    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(watchdogTick, WATCHDOG_POLL_MS);
  }

  // Watchdog runs every WATCHDOG_POLL_MS. Jobs:
  //   1) If SR isn't active, start it (covers cases where onend never fires).
  //   2) Deaf-SR: if SR has been running past warmup with zero audio activity
  //      (no onspeechstart, no results in THIS instance), Chrome's speech
  //      service has gone quiet — recycle before the hard recycle at 75s.
  //   3) True stall: SR fired onspeechstart but no result within SR_STALL_MS.
  //   4) Pre-emptive recycle every SR_HARD_RECYCLE_MS to avoid Chrome auto-kill.
  // On any recycle, show a brief "Reconnecting" HUD so the user knows to wait.
  const SR_WARMUP_MS = 3000; // ignore activity-check signals for first 3s after start
  function watchdogTick() {
    if (!state.listening) return;
    if (state.mode === "ptt" && !state.pttHeld) return;

    if (!recogActive) {
      log("watchdog: SR inactive, starting");
      startSR();
      return;
    }

    const now = performance.now();
    const sinceStart = now - srStartedAt;

    // Deaf-SR: no onspeechstart or onresult since this instance started.
    // Video audio should always give SR some signal; total silence means the
    // service dropped. Recycle early so the user isn't waiting 75s.
    if (lastActivityAt === 0 && sinceStart > SR_WARMUP_MS + SR_DEAF_MS) {
      log("watchdog: deaf-SR — no audio activity since start, recycling");
      lastActivityAt = now; // prevent tight re-trigger before onend fires
      showHud("Reconnecting…", "info");
      try { recog?.stop(); } catch {}
      return;
    }

    // Real stall: SR fired onspeechstart AFTER warmup AND no result followed
    // within SR_STALL_MS. The warmup gate prevents a single bleed-triggered
    // onspeechstart at startup from causing an immediate false stall.
    if (sinceStart > SR_WARMUP_MS &&
        lastSpeechStartAt > srStartedAt + SR_WARMUP_MS &&
        (now - lastSpeechStartAt) > SR_STALL_MS &&
        lastResultAt < lastSpeechStartAt) {
      log("watchdog: STALL — speechstart fired but no result in", SR_STALL_MS, "ms");
      lastSpeechStartAt = 0; // don't loop
      showHud("Reconnecting…", "info");
      try { recog?.abort(); } catch {}
      return;
    }

    const userSpokeRecently = state.speaking || (now - lastResultAt) < SR_RECENT_SPEECH_MS;
    if (sinceStart > SR_HARD_RECYCLE_MS && !userSpokeRecently) {
      log("watchdog: pre-emptive recycle (Chrome auto-kill avoidance)");
      showHud("Reconnecting…", "info");
      try { recog?.stop(); } catch {}
    }
  }

  function stopListening() {
    state.listening = false;
    state.pttHeld = false;
    state.loop.markStart = null; // discard any pending mark-start on mic-off
    stopSR();
    stopAudioMonitor();
    speechDuckOff();
    hideTip();
    bleed.reset();
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    lastInterim = "";
    speechTimeRefined = false;
    restoreVideo();
    setStatus("SetLoop", "idle");
    syncState();
  }

  function duckVideo() {
    const v = getVideo(); if (!v) return;
    if (state.duckedVolume == null) {
      state.duckedVolume = v.volume;
      v.volume = state.duckedVolume * DUCK_RATIO;
    }
  }
  function restoreVideo() {
    const v = getVideo(); if (!v) return;
    if (state.duckedVolume != null) {
      v.volume = state.duckedVolume;
      state.duckedVolume = null;
    }
  }

  // Transient duck: fires when an interim transcript with a command trigger
  // appears, so video doesn't drown out the rest of the user's command.
  // Auto-restores on final OR after SPEECH_DUCK_MAX_MS (safety).
  let speechDuckTimer = null;
  const SPEECH_DUCK_MAX_MS = 3500;
  function speechDuckOn() {
    const v = getVideo(); if (!v) return;
    if (speechDuckActive) {
      // Refresh max-timer if duck already on
      if (speechDuckTimer) clearTimeout(speechDuckTimer);
      speechDuckTimer = setTimeout(speechDuckOff, SPEECH_DUCK_MAX_MS);
      return;
    }
    speechDuckActive = true;
    if (state.duckedVolume == null) state.duckedVolume = v.volume;
    v.volume = state.duckedVolume * SPEECH_DUCK_RATIO;
    if (speechDuckTimer) clearTimeout(speechDuckTimer);
    speechDuckTimer = setTimeout(speechDuckOff, SPEECH_DUCK_MAX_MS);
  }
  function speechDuckOff() {
    if (speechDuckTimer) { clearTimeout(speechDuckTimer); speechDuckTimer = null; }
    if (!speechDuckActive) return;
    speechDuckActive = false;
    const v = getVideo(); if (!v) return;
    if (state.duckedVolume != null) {
      v.volume = state.listening && state.duck
        ? state.duckedVolume * DUCK_RATIO
        : state.duckedVolume;
      if (!(state.listening && state.duck)) state.duckedVolume = null;
    }
  }

  function toggle() {
    log("toggle() — listening =", state.listening);
    createOverlay();
    const kind = pageKind();
    if (kind === "youtube-shorts") {
      toast("SetLoop doesn't support YouTube Shorts yet");
      showHud("Not supported on Shorts", "info"); return;
    }
    if (kind === "no-video" || kind === "unknown") {
      toast("No video found on this page");
      showHud("No video found", "info"); return;
    }
    if (state.listening) { stopListening(); toast("Voice OFF"); }
    else { startListening(); toast(`Voice ON · ${state.mode === "ptt" ? "Hold \` to speak" : "Listening"}`); }
  }

  // ── Push-to-talk ────────────────────────────────────────────────────

  function isEditableTarget(t) {
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }
  let pttStopTimer = null;
  document.addEventListener("keydown", (e) => {
    if (state.mode !== "ptt" || !state.listening || state.pttHeld) return;
    if (e.code !== state.pttKey) return;
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
    if (pttStopTimer) { clearTimeout(pttStopTimer); pttStopTimer = null; }
    state.pttHeld = true;
    setStatus("Speak now…", "listening");
    showHud("Listening…", "interim");
    startSR();
  });
  document.addEventListener("keyup", (e) => {
    if (state.mode !== "ptt" || !state.pttHeld || e.code !== state.pttKey) return;
    e.preventDefault();
    state.pttHeld = false;
    if (pttStopTimer) clearTimeout(pttStopTimer);
    pttStopTimer = setTimeout(() => {
      pttStopTimer = null;
      if (!state.pttHeld) { try { recog?.stop(); } catch {} }
    }, 500);
    setStatus("Hold ` to speak", state.loop.active ? "loop" : "idle");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Always force-recycle on tab return — don't trust recogActive, since
    // Chrome can throttle/kill SR while the tab is hidden without firing
    // onend, leaving the flag stale. abort() + the existing restart loop
    // gives us a fresh recogniser within ~200ms.
    if (state.listening && state.mode !== "ptt") {
      log("visibility restore — force recycling SR");
      showHud("Reconnecting…", "info");
      try { recog?.abort(); } catch {}
      // Fallback in case abort didn't trigger onend (shouldn't happen, belt+suspenders)
      setTimeout(() => {
        if (state.listening && !recogActive && state.mode !== "ptt") {
          log("visibility restore — onend never fired, manual restart");
          startSR();
        }
      }, 400);
    }
    if (!overlay) return;
    if (state.loop.active) setStatus(loopLabel(), "loop");
    else if (state.listening) setStatus(state.mode === "ptt" ? "Hold ` to speak" : "Listening",
                                         state.mode === "ptt" ? "idle" : "listening");
  });

  // YouTube SPA navigation — refresh bookmarks for new video.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    state.videoId = getVid();
    loadBm();
    log("navigation → new videoId", state.videoId);
  }, 1500);

  // ── Message routing ──────────────────────────────────────────────────

  const VALID_TYPES = new Set([
    "ping", "toggle", "status", "set-mode", "set-strict", "set-duck",
    "quick-bookmark", "get-bookmarks", "go-to-bookmark", "delete-bookmark",
  ]);

  function statusResponse() {
    return {
      listening: state.listening,
      loopActive: state.loop.active,
      mode: state.mode,
      strict: state.strict,
      duck: state.duck,
      supported: isSupportedPage(),
      pageKind: pageKind(),
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (!msg || typeof msg.type !== "string" || !VALID_TYPES.has(msg.type)) return;

    switch (msg.type) {
      case "ping": respond({ pong: true }); break;
      case "toggle": toggle(); respond(statusResponse()); break;
      case "status": respond(statusResponse()); break;

      case "set-mode": {
        if (!["always", "ptt"].includes(msg.value)) break;
        const prev = state.mode;
        state.mode = msg.value; saveCfg();
        if (state.mode === "ptt") hideTip();
        bleed.reset();
        if (state.listening && prev !== state.mode) {
          stopSR();
          if (state.mode !== "ptt") startSR();
          else setStatus("Hold ` to speak", "paused");
        } else if (state.listening) {
          if (state.mode === "always") setStatus("Listening", "listening");
          else setStatus("Hold ` to speak", "idle");
        }
        toast(`Mode: ${state.mode === "ptt" ? "Push-to-Talk" : "Always On"}`);
        respond({ ok: true, mode: state.mode });
        break;
      }

      case "set-strict": {
        state.strict = !!msg.value; saveCfg();
        toast(`Strict: ${state.strict ? "ON" : "OFF"}`);
        respond({ ok: true, strict: state.strict });
        break;
      }

      case "set-duck": {
        state.duck = !!msg.value; saveCfg();
        if (state.listening) { if (state.duck) duckVideo(); else restoreVideo(); }
        toast(`Auto-duck: ${state.duck ? "ON" : "OFF"}`);
        respond({ ok: true, duck: state.duck });
        break;
      }

      case "quick-bookmark": createOverlay(); addBm(); respond({ ok: true }); break;
      case "get-bookmarks": respond({ bookmarks: state.bookmarks, videoId: state.videoId }); break;

      case "go-to-bookmark": {
        if (typeof msg.time !== "number") break;
        const v = getVideo();
        if (v) { v.currentTime = msg.time; toast(`→ ${fmt(msg.time)}`); }
        respond({ ok: true }); break;
      }
      case "delete-bookmark": {
        if (typeof msg.id !== "number") break;
        state.bookmarks = state.bookmarks.filter(b => b.id !== msg.id);
        saveBm(); respond({ ok: true }); break;
      }
    }
  });

  // Popup bridge — chrome.scripting.executeScript from a popup click
  // preserves user activation into this isolated world, which is what
  // webkitSpeechRecognition.start() needs on first use.
  window.__setloop = {
    toggle: () => { toggle(); return statusResponse(); },
    start: () => { createOverlay(); if (!state.listening) startListening(); return statusResponse(); },
    stop: () => { if (state.listening) stopListening(); return statusResponse(); },
    status: () => statusResponse(),
  };

  loadBm();
  log("content script ready on", location.hostname);
})();
