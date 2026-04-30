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
  if (window.__vl) return;
  window.__vl = true;

  const DEBUG = true;
  const log = (...a) => { if (DEBUG) console.log("[SetLoop]", ...a); };

  const TOAST_MS = 2200;
  const RAMP_STEP = 0.05;
  const FIRE_DEDUP_MS = 2500;   // covers the gap between interim and final
  const SR_HEALTH_MS = 30000;
  const DUCK_RATIO = 0.4;       // video volume while listening (if auto-duck on)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

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
    if (mode === "loop" || mode === "paused" || !lbl.classList.contains("vl-label-interim")) {
      lbl.textContent = text; lbl.classList.remove("vl-label-interim");
    }
    $("#vlDot").className = "vl-dot" + ({
      listening: " vl-dot-on", loop: " vl-dot-loop", success: " vl-dot-ok",
      error: " vl-dot-err", paused: " vl-dot-paused",
    }[mode] || "");
    $("#vlPill").className = "vl-pill" + ({
      listening: " vl-pill-on", loop: " vl-pill-loop", paused: " vl-pill-paused",
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
  function toast(m) {
    if (!overlay) return;
    const t = $("#vlToast"); t.textContent = m;
    t.classList.add("vl-toast-show");
    clearTimeout(toastTmr);
    toastTmr = setTimeout(() => t.classList.remove("vl-toast-show"), TOAST_MS);
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
    let t = " " + raw.toLowerCase() + " ";

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

    // Mark start/end — gate to short utterances so video narration like
    // "Mark Stark, the guitarist..." doesn't rewrite on a long interim.
    // Also support "mark in" / "mark out" (standard in/out-point terminology).
    if (shortUtterance) {
      t = t.replace(/\bmark\s+(?:stop|stops|stark)\b/g, "mark start");
      // "mark in" intentionally NOT rewritten to mark_start — Chrome can
      // mishear "mark end" as "mark in", which would fire the wrong command.
      t = t.replace(/\bmark\s+(?:and|n|ned|out)\b/g, "mark end");
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

    // Tighter / wider
    t = t.replace(/\b(?:titer|tyter)\b/g, "tighter");
    t = t.replace(/\bwyder\b/g, "wider");

    // Speed / faster / slower
    t = t.replace(/\b(?:sped|spd)\b/g, "speed");
    t = t.replace(/\bspeed\s*up\b/g, "faster");
    t = t.replace(/\bslow\s*down\b/g, "slower");

    return t.trim().replace(/\s+/g, " ");
  }

  function parse(raw) {
    // Filler-word guard: transcripts containing narrative markers are
    // almost certainly video audio, not commands. Reject before we even
    // try to parse so a "loop" that appears mid-sentence doesn't fire.
    if (FILLER_REJECT.test(raw)) return null;

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

    const STRICT_ALLOWLIST = /^(?:mark\s+start|mark\s+end|mic\s+off|stop\s+listening|turn\s+off)$/;
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

    if (/^mark\s+start$/.test(cmd) || /^mark\s+start$/.test(t)) return { a: "mark_start" };
    if (/^mark\s+end$/.test(cmd) || /^mark\s+end$/.test(t)) return { a: "mark_end" };

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
        state.loop.markStart = v.currentTime;
        const m = `Start ${fmt(v.currentTime)} — say "mark end"`;
        toast(m); showHud(m, "cmd"); break;
      }
      case "mark_end": {
        if (state.loop.markStart == null) {
          toast(`Set start first — say "mark start"`);
          showHud("Mark start first", "info"); break;
        }
        const s = Math.min(state.loop.markStart, v.currentTime);
        const e = Math.max(state.loop.markStart, v.currentTime);
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
    syncState();

    const check = () => {
      if (!state.loop.active) return;
      if (isAdPlaying()) return;
      updateProgress();
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
    syncState();
  }

  // ── SpeechRecognition host ────────────────────────────────────────────

  let recog = null;
  let recogGen = 0;
  let recogActive = false;
  let restartTimer = null;
  let lastResultAt = 0;
  let healthTimer = null;

  let lastInterim = "";
  let lastFired = { sig: null, at: 0 };

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

  function tryFire(text, confidence, isFinal) {
    let cmd;
    try { cmd = parse(text); } catch (e) { log("parse threw:", e.message); cmd = null; }
    if (!cmd) return false;

    if (!isFinal && !INTERIM_EAGER.has(cmd.a)) return false;
    if (!isFinal && state.strict && confidence != null && confidence < 0.65) return false;

    const sig = cmdSignature(cmd);
    const now = performance.now();
    // Dedup INCLUDES stamping the time so any follow-up interim/final with
    // the same signature within FIRE_DEDUP_MS is silently swallowed.
    if (sig === lastFired.sig && (now - lastFired.at) < FIRE_DEDUP_MS) {
      lastFired.at = now; // refresh so repeated fires keep extending the window
      return true;
    }
    lastFired = { sig, at: now };
    log(`fire (${isFinal ? "final" : "interim"}, conf=${confidence}):`, text, "→", cmd);
    if (overlay) $("#vlDot").classList.remove("vl-dot-hearing", "vl-dot-processing");
    exec(cmd);
    // Force-finalise on interim-eager fires: calling stop() pushes Chrome
    // to emit the final immediately and restart the recogniser clean. This
    // cuts the ~1-2s lag between interim and final for simple commands.
    if (!isFinal && recogActive && INTERIM_EAGER.has(cmd.a)) {
      try { recog?.stop(); } catch {}
    }
    return true;
  }

  function handleResult(text, isFinal, confidence) {
    if (isFinal) {
      log("final:", text, "conf=", confidence);
      const fired = tryFire(text, confidence, true);

      if (!fired && overlay) {
        state.speechStartTime = null;
        const dot = $("#vlDot");
        if (dot) {
          dot.classList.remove("vl-dot-hearing", "vl-dot-processing");
          dot.classList.add("vl-dot-miss");
          setTimeout(() => $("#vlDot")?.classList.remove("vl-dot-miss"), 800);
        }
      }
      lastInterim = "";
    } else {
      if (text === lastInterim) return;
      lastInterim = text;
      showInterimOnPill(text);
      tryFire(text, confidence, false);
    }
  }

  function buildRecogniser() {
    const r = new SR();
    r.lang = "en-US";
    r.continuous = state.mode === "always";
    r.interimResults = true;
    r.maxAlternatives = 1;

    const myGen = ++recogGen;

    r.onstart = () => {
      if (myGen !== recogGen) return;
      recogActive = true;
      lastResultAt = performance.now();
      log("SR onstart");
      if (state.listening) {
        setStatus(state.mode === "ptt" && !state.pttHeld ? "Hold ` to speak" : "Listening",
                  state.mode === "ptt" && !state.pttHeld ? "idle" : "listening");
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
      }, 200);
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
        state.listening = false;
        setStatus("Voice unavailable here", "error");
        syncState();
      }
      // "no-speech" / "audio-capture" / "aborted" — routine; onend restarts.
    };

    r.onresult = (e) => {
      if (myGen !== recogGen) return;
      lastResultAt = performance.now();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        const text = alt?.transcript?.trim();
        if (!text) continue;
        const conf = typeof alt.confidence === "number" && alt.confidence > 0
          ? alt.confidence : null;
        handleResult(text, res.isFinal, conf);
      }
    };

    r.onspeechstart = () => {
      if (myGen !== recogGen) return;
      state.speaking = true;
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
      if (e.name === "InvalidStateError") { recogActive = true; return; }
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

  function startListening() {
    state.listening = true;
    setStatus("Starting…", "paused");
    syncState();
    if (state.mode !== "ptt") startSR();
    else setStatus("Hold ` to speak", "paused");
    if (state.duck) duckVideo();

    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (!state.listening) return;
      if (state.mode === "ptt" && !state.pttHeld) return;
      if (!recogActive) { startSR(); return; }
      if (performance.now() - lastResultAt > SR_HEALTH_MS) {
        log("SR idle — recycling");
        try { recog?.stop(); } catch {}
      }
    }, SR_HEALTH_MS);
  }

  function stopListening() {
    state.listening = false;
    state.pttHeld = false;
    stopSR();
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
    lastInterim = "";
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
    // If SR stalled while the tab was hidden (DevTools, tab switch, etc.), restart it.
    if (state.listening && !recogActive && state.mode !== "ptt") {
      log("visibility restore — restarting stalled SR");
      startSR();
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
