(() => {
  "use strict";
  if (window.__vl) return;
  window.__vl = true;

  const LOOP_POLL_MS = 50, TOAST_MS = 2200, RAMP_STEP = 0.05;

  const DEFAULT_QUICK_ACTIONS = [
    { label: "⟳20s 75%", secs: 20, spd: 0.75 },
    { label: "⟳30s 50%", secs: 30, spd: 0.50 },
    { label: "■ Stop", secs: 0, spd: 0 },
  ];

  const state = {
    listening: false,
    mode: "always", pttKey: "Backquote", pttHeld: false,
    loop: { active: false, start: 0, end: 0, interval: null, preRate: 1, count: 0, ramp: false },
    bookmarks: [], videoId: getVid(),
    quickActions: DEFAULT_QUICK_ACTIONS.slice(),
    editing: false,
    speechStartTime: null,
    vadReady: false,
  };

  // ═══ Config ═══
  chrome?.storage?.local?.get("vl_cfg", (d) => {
    const c = validateCfg(d?.vl_cfg);
    if (!c) return;
    state.mode = c.mode;
    state.pttKey = c.pttKey;
    state.quickActions = c.quickActions;
  });

  function validateCfg(c) {
    if (!c || typeof c !== "object") return null;
    return {
      mode: ["always", "ptt"].includes(c.mode) ? c.mode : "always",
      pttKey: typeof c.pttKey === "string" && c.pttKey.length < 30 ? c.pttKey : "Backquote",
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
        vl_cfg: { mode: state.mode, pttKey: state.pttKey, quickActions: state.quickActions },
      });
    } catch {}
  }

  function syncState() {
    try {
      chrome?.storage?.local?.set({
        vl_state: { listening: state.listening, loopActive: state.loop.active, mode: state.mode },
      });
    } catch {}
    chrome.runtime.sendMessage({
      type: "state-update",
      listening: state.listening,
      loopActive: state.loop.active,
    });
  }

  // ═══ Helpers ═══
  function $(s) { return document.querySelector(s); }
  function getVid() { try { const u = new URL(location.href); return u.hostname.includes("youtube") ? (u.searchParams.get("v") || u.pathname) : u.pathname; } catch { return location.href; } }
  function fmt(s) { return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function getVideo() { const a = [...document.querySelectorAll("video")]; if (!a.length) return null; return a.reduce((x, y) => { const ra = x.getBoundingClientRect(), rb = y.getBoundingClientRect(); return (rb.width * rb.height) > (ra.width * ra.height) ? y : x; }); }
  function tsUrl(t) { try { const u = new URL(location.href); if (u.hostname.includes("youtube")) u.searchParams.set("t", `${Math.floor(t)}s`); else u.hash = `t=${Math.floor(t)}`; return u.toString(); } catch { return location.href; } }
  function copyText(t) { navigator.clipboard.writeText(t).catch(() => { const e = document.createElement("textarea"); e.value = t; e.style.cssText = "position:fixed;left:-9999px"; document.body.appendChild(e); e.select(); document.execCommand("copy"); document.body.removeChild(e); }); }

  // ═══ Audio beep ═══
  let audioCtx = null;
  function beep(freq = 880, dur = 0.08) {
    try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.frequency.value = freq; o.type = "sine"; g.gain.value = 0.08; o.start(); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur); o.stop(audioCtx.currentTime + dur); } catch {}
  }

  // ═══ Bookmarks ═══
  function loadBm() { chrome?.storage?.local?.get(`vl_bm_${state.videoId}`, (d) => { state.bookmarks = validateBookmarks(d?.[`vl_bm_${state.videoId}`]); }); }
  function saveBm() { chrome?.storage?.local?.set({ [`vl_bm_${state.videoId}`]: state.bookmarks }); }
  function addBm() { const v = getVideo(); if (!v) return; const t = v.currentTime; state.bookmarks.push({ id: Date.now(), time: t, label: fmt(t), speed: v.playbackRate, created: new Date().toISOString() }); saveBm(); beep(); toast(`Bookmarked ${fmt(t)}`); showHud(`Bookmarked ${fmt(t)}`, "info"); }

  function validateBookmarks(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(b =>
      b && typeof b.id === "number" &&
      typeof b.time === "number" && b.time >= 0 &&
      typeof b.label === "string" && b.label.length < 100
    ).slice(0, 200);
  }

  // ═══ Overlay ═══
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
    const hud = document.createElement("div"); hud.id = "vlHud"; hud.className = "vl-hud"; hud.innerHTML = `<span id="vlHudText" class="vl-hud-text"></span>`; document.body.appendChild(hud);
    $("#vlMic").addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    $("#vlBm").addEventListener("click", (e) => { e.stopPropagation(); addBm(); });
    $("#vlCopy").addEventListener("click", (e) => { e.stopPropagation(); const v = getVideo(); if (v) { copyText(tsUrl(v.currentTime)); beep(); toast("Link copied"); } });
    $("#vlEdit").addEventListener("click", (e) => { e.stopPropagation(); toggleEdit(); });
    renderQA(); drag($("#vlPill"));
  }

  // ═══ Quick Actions (DOM-based, no innerHTML for dynamic data) ═══
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

      const saveBtn = document.createElement("button");
      saveBtn.className = "vl-qa vl-qa-save"; saveBtn.textContent = "✓";
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
      state.quickActions.forEach((q, i) => {
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
  function toggleEdit() { state.editing = !state.editing; const b = $("#vlEdit"); if (b) b.textContent = state.editing ? "✕" : "⚙"; renderQA(); }

  // ═══ HUD / Pill / Drag / Status ═══
  function posHud() {
    const h = document.getElementById("vlHud");
    const qaRow = document.querySelector(".vl-qa-row");
    const pill = document.getElementById("vlPill");
    if (!h) return;
    const anchor = qaRow || pill;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    h.style.right = "12px";
    h.style.left = "auto";
    h.style.top = `${r.bottom + 8}px`;
  }
  function showHud(text, type) { const el = document.getElementById("vlHudText"), hud = document.getElementById("vlHud"); if (!el || !hud) return; posHud(); el.textContent = type === "cmd" ? `✓ ${text}` : type === "interim" ? `${text}…` : text; hud.className = `vl-hud vl-hud-show vl-hud-${type}`; clearTimeout(hud._t); hud._t = setTimeout(() => { hud.className = "vl-hud"; }, type === "cmd" ? 2000 : type === "interim" ? 3500 : 1800); }
  let pillResetTimer = null;
  function showInterimOnPill(text) {
    if (!overlay) return;
    if (state.loop.active) { showHud(`Heard: ${text}`, "interim"); return; }
    const lbl = $("#vlLabel"); if (!lbl) return;
    lbl.textContent = `"${text}"`; lbl.classList.add("vl-label-interim");
    clearTimeout(pillResetTimer); pillResetTimer = setTimeout(() => { lbl.classList.remove("vl-label-interim"); if (state.listening) lbl.textContent = "Listening"; else lbl.textContent = "SetLoop"; }, 1200);
  }
  function drag(el) { let d = false, sx, sy, ox, oy; el.addEventListener("pointerdown", (e) => { if (e.target.closest(".vl-btn,.vl-edit-btn")) return; d = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; el.setPointerCapture(e.pointerId); el.style.transition = "none"; }); el.addEventListener("pointermove", (e) => { if (!d) return; el.style.position = "fixed"; el.style.left = `${ox + e.clientX - sx}px`; el.style.top = `${oy + e.clientY - sy}px`; el.style.right = "auto"; el.style.bottom = "auto"; }); el.addEventListener("pointerup", () => { d = false; el.style.transition = ""; }); }
  function setStatus(text, mode = "idle") {
    if (!overlay) return;
    const lbl = $("#vlLabel");
    if (mode === "loop" || mode === "paused" || !lbl.classList.contains("vl-label-interim")) { lbl.textContent = text; lbl.classList.remove("vl-label-interim"); }
    $("#vlDot").className = "vl-dot" + ({ listening: " vl-dot-on", loop: " vl-dot-loop", success: " vl-dot-ok", error: " vl-dot-err", paused: " vl-dot-paused" }[mode] || "");
    $("#vlPill").className = "vl-pill" + ({ listening: " vl-pill-on", loop: " vl-pill-loop", paused: " vl-pill-paused" }[mode] || "");
    const mic = $("#vlMic");
    mic.classList.remove("vl-btn-active", "vl-btn-paused");
    if (mode === "paused") mic.classList.add("vl-btn-paused");
    else if (state.listening || state.pttHeld) mic.classList.add("vl-btn-active");
    syncState();
  }
  function updateProgress() { if (!overlay) return; const b = $("#vlProgress"); if (!state.loop.active) { b.style.width = "0"; return; } const v = getVideo(); if (!v) return; b.style.width = `${clamp((v.currentTime - state.loop.start) / (state.loop.end - state.loop.start), 0, 1) * 100}%`; }
  function toast(m) { if (!overlay) return; const t = $("#vlToast"); t.textContent = m; t.classList.add("vl-toast-show"); clearTimeout(toastTmr); toastTmr = setTimeout(() => t.classList.remove("vl-toast-show"), TOAST_MS); }

  // ═══ Number / Time Parsing ═══
  const W = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,half:50,quarter:25,double:200 };
  function num(t) { const s = t.toLowerCase().trim(), n = parseFloat(s); if (!isNaN(n)) return n; const p = s.match(/^(.+?)\s+point\s+(.+)$/); if (p) { const a = num(p[1]), b = num(p[2]); if (!isNaN(a) && !isNaN(b)) return a + b / 10 ** Math.ceil(Math.log10(b + 1)); } if (W[s] !== undefined) return W[s]; let c = 0; for (const x of s.split(/[\s-]+/)) { const v = W[x]; if (v === undefined) continue; if (v === 100) c = (c || 1) * 100; else c += v; } return c || NaN; }
  function parseTime(s) { s = s.trim(); const c = s.match(/^(\d+):(\d+)$/); if (c) return +c[1] * 60 + +c[2]; const m = s.match(/(\w+)\s+minutes?\s*(?:and\s+)?(\w+)?\s*(?:seconds?)?/i); if (m) { const v = num(m[1]); return isNaN(v) ? NaN : v * 60 + (m[2] ? (num(m[2]) || 0) : 0); } const o = s.match(/(\w+)\s+minutes?/i); if (o) { const v = num(o[1]); return isNaN(v) ? NaN : v * 60; } const z = s.match(/(\w+)\s*(?:seconds?|secs?)?$/i); if (z) { const v = num(z[1]); return isNaN(v) ? NaN : v; } return NaN; }

  // ═══ Parser ═══
  // ═══ Phonetic Command Matching ═══
  // Double Metaphone approximation for our small vocabulary.
  // Maps phonetically similar words to command words automatically.
  const COMMAND_WORDS = {
    loop: ["loop", "lupe", "lup", "loo"],
    last: ["last", "las", "lass"],
    stop: ["stop", "stap", "stp"],
    wider: ["wider", "wyder"],
    tighter: ["tighter", "tytr"],
    slower: ["slower", "slowr"],
    faster: ["faster", "fastr"],
    speed: ["speed", "sped", "spd"],
    back: ["back", "bak", "bac"],
    forward: ["forward", "fwd"],
    bookmark: ["bookmark", "bookmrk"],
    pause: ["pause", "paws", "paz"],
    play: ["play", "ply"],
  };

  // Exact variant matching only — edit distance was too aggressive
  // (e.g., "stop" → "loop" at distance 2). The explicit whisperFix
  // table handles observed mishears. This catches remaining exact variants.
  function phoneticMatch(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (w.length < 2) return word;
    for (const [cmd, variants] of Object.entries(COMMAND_WORDS)) {
      for (const v of variants) {
        if (w === v) return cmd;
      }
    }
    return word;
  }

  function phoneticFix(text) {
    return text.replace(/\b[a-zA-Z]+\b/g, w => phoneticMatch(w));
  }

  // Whisper correction pipeline: explicit fixes → phonetic matching
  function whisperFix(raw) {
    let t = raw;

    // Phase 1: Fix compound "set loop" patterns first (from real logs)
    // Whisper hears "set loop" as these consistently:
    t = t.replace(/\bthat\s+loop\b/gi, "loop");        // most common
    t = t.replace(/\bstep[,.]?\s+loop\b/gi, "loop");   // "Step, loop"
    t = t.replace(/\bset\s+loop\b/gi, "loop");          // correct hear
    t = t.replace(/\bso\s+the\s+last\b/gi, "loop last"); // "So the last"
    t = t.replace(/\bst\.?\s*luke\b/gi, "loop");        // "St. Luke"
    t = t.replace(/\bsalute\b/gi, "loop");              // "Salute"
    t = t.replace(/\bdeathloop\b/gi, "loop");           // "Deathloop"
    t = t.replace(/\bcertainly\b/gi, "loop");           // "Certainly"
    t = t.replace(/\bat\s+loop\b/gi, "loop");           // "at Loop"

    // Phase 2: Fix standalone "set" before loop-like words
    t = t.replace(/\b(?:that|said|sit|sat|this|step)\b(?=\s+(?:loop|last|stop|move|could))/gi, "set");
    t = t.replace(/\bset\s+(?=last|stop|move)/gi, "loop ");

    // Phase 3: Fix "loop" mishears
    t = t.replace(/\bluke\b/gi, "loop");
    t = t.replace(/\blook\b/gi, "loop");
    t = t.replace(/\blouie\b/gi, "loop");
    t = t.replace(/\blouvre\b/gi, "loop");
    t = t.replace(/\blou\b/gi, "loop");
    t = t.replace(/\bmove\b(?=\s*[,.]?\s*stop)/gi, "loop");  // "that move, stop"
    t = t.replace(/\bblue\b/gi, "loop");
    t = t.replace(/\bwe'?ve\b/gi, "loop");
    t = t.replace(/\bwould\b(?=\s+(?:last|stop))/gi, "loop"); // "would last/stop"
    t = t.replace(/\bwho[op]+\b/gi, "loop");
    t = t.replace(/\bnew\b(?=\s+(?:last|stop|fast|slow|wide|tight))/gi, "loop");
    t = t.replace(/\bcouldn'?t\b(?=\s+stop)/gi, "loop");  // "couldn't stop"
    t = t.replace(/\boops\b/gi, "loop");                   // "Oops stop"
    t = t.replace(/\bnope\b/gi, "loop");                   // "Nope, stop"
    t = t.replace(/\bwe'?ll\b(?=\s+stop)/gi, "loop");     // "we'll stop"
    t = t.replace(/\blupa\b/gi, "loop");                   // "Lupa, stop"
    t = t.replace(/\bscott\b/gi, "stop");                  // "Luke Scott" → "loop stop"
    t = t.replace(/\bloot\b/gi, "loop");                   // "loot last"
    t = t.replace(/\bwhoops\b/gi, "loop");                 // "whoops, stop"
    t = t.replace(/\bgroup\s+class\b/gi, "loop last");     // "Group class 16..."
    t = t.replace(/\bblueglass\b/gi, "loop last");         // "Blueglass 17..."
    t = t.replace(/\bblue\s*glass\b/gi, "loop last");      // "Blue glass 17..."
    t = t.replace(/\broup\b/gi, "loop");                   // "Roup, last"
    t = t.replace(/\bmoop\b/gi, "loop");                   // "Moop stop"
    t = t.replace(/\bwe\s+can\b(?=\s+stop)/gi, "loop");   // "we can stop"

    // Phase 4: "last" mishears — very common, Whisper hears "blast"/"class"
    t = t.replace(/\bblast\b/gi, "last");
    t = t.replace(/\bclass\b/gi, "last");
    t = t.replace(/\bass\b(?=\s+\d)/gi, "last");          // "loop as 14" → "loop last 14"

    // Compound normalization
    t = t.replace(/\bloops?\s+last/gi, "loop last");
    t = t.replace(/\bthe\s+next\b/gi, "loop last");
    t = t.replace(/\bokay\s*,?\s*that'?s?\b/gi, "loop last");

    // Phase 5: "at" and number fixes
    // Split joined numbers: "1941" → "19 at 41" (Whisper joins "19 at 41" into "1941")
    t = t.replace(/\b(\d{2})(\d{2,3})\b/g, (_, a, b) => {
      const na = +a, nb = +b;
      if (na >= 5 && na <= 60 && nb >= 10 && nb <= 200) return `${na} at ${nb}`;
      return a + b;
    });
    t = t.replace(/\b(\d+)\s+to\s+(\d+)/gi, "$1 at $2");
    t = t.replace(/\b(\d+)\s*x\s*(\d+)/gi, "$1 at $2");
    t = t.replace(/(\d+)-(\d+)/g, "$1 at $2");
    t = t.replace(/\btwo\s+(\d+)/gi, "to $1");

    // Phase 6: "stop" mishears
    t = t.replace(/\bstop it\b/gi, "stop");
    t = t.replace(/\bstyle\b/gi, "stop");
    t = t.replace(/\bsky\b/gi, "stop");                  // "blue sky" → "loop stop"

    // Phase 7: Spacing cleanup
    t = t.replace(/loop\s*last/gi, "loop last");

    // Phase 8: Phonetic matching — catches remaining mishears algorithmically
    t = phoneticFix(t);

    return t;
  }

  function parse(raw) {
    let c = whisperFix(raw).toLowerCase().trim().replace(/[.!,?]+/g, "");
    c = c.replace(/loop\s+lasts?\s+/g, "loop last ");
    c = c.replace(/\s+i\s+think\s+/g, " at ");

    // SUBSTRING: "loop last N at X" anywhere in transcript
    let m = c.match(/loop\s+last\s+(\w+)\s*(?:(?:at|and)\s+(\w+)\s*(?:percent|%)?\s*(?:speed)?)?\s*(ramp(?:\s+up)?)?/);
    if (m) { const s = parseTime(m[1]); if (!isNaN(s) && s > 0 && s < 600) { let spd = null; if (m[2]) { let v = num(m[2]); if (!isNaN(v)) { spd = v > 4 ? v / 100 : v; spd = clamp(spd, 0.1, 4); } } return { a: "loop_last", secs: s, spd, ramp: !!m[3] }; } }

    // Loop range — substring
    m = c.match(/loop\s+(?:from\s+)?(\d+(?::\d+)?)\s+to\s+(\d+(?::\d+)?)(?:\s+(?:at|and)\s+(\w+)\s*(?:percent|%)?)?/);
    if (m) { const s = parseTime(m[1]), e = parseTime(m[2]); if (!isNaN(s) && !isNaN(e)) { let spd = null; if (m[3]) { let v = num(m[3]); if (!isNaN(v)) { spd = v > 4 ? v / 100 : v; spd = clamp(spd, 0.1, 4); } } return { a: "loop_range", start: s, end: e, spd }; } }

    // SHORT COMMANDS — require "loop" prefix in Always On mode
    const hasPrefix = /(?:^|\s)loop\s+/.test(c);
    const stripped = c.replace(/^(?:.*\s)?loop\s+/, "").trim();

    // In Always On mode, short commands MUST have "loop" prefix to prevent
    // video audio from triggering commands (e.g., instructor saying "stop")
    if (c.split(/\s+/).length <= 5) {
      const cmds = state.mode === "always" ? stripped : (stripped || c);
      const raw_c = c;

      if (state.mode === "ptt" || hasPrefix) {
        if (/^(?:mic\s+off|stop\s+listening|turn\s+off)$/.test(cmds)) return { a: "mic_off" };
        if (/^(?:stop|cancel|end\s+loop|quit)(?:\s+loop(?:ing)?)?$/.test(cmds)) return { a: "stop" };
        if (/^wider$/.test(cmds)) return { a: "adjust", startDelta: -2, endDelta: 0 };
        if (/^tighter$/.test(cmds)) return { a: "adjust", startDelta: 2, endDelta: 0 };
        if (/^shift\s+back$/.test(cmds)) return { a: "adjust", startDelta: -2, endDelta: -2 };
        if (/^shift\s+forward$/.test(cmds)) return { a: "adjust", startDelta: 2, endDelta: 2 };
        m = cmds.match(/^(?:set\s+)?speed\s+(?:to\s+)?(\w+)(?:\s*(?:percent|%))?$/); if (m) { let r = num(m[1]); if (isNaN(r)) return null; if (r > 4) r /= 100; return { a: "speed", rate: clamp(r, 0.1, 4) }; }
        if (/^(?:normal\s+speed|reset(?:\s+speed)?)$/.test(cmds)) return { a: "speed", rate: 1 };
        if (/^(?:slow(?:er)?|slow\s*down)$/.test(cmds)) return { a: "nudge", d: -0.25 };
        if (/^(?:fast(?:er)?|speed\s*up)$/.test(cmds)) return { a: "nudge", d: 0.25 };
        m = cmds.match(/^back\s+(\w+)$/); if (m) { const s = parseTime(m[1]); if (!isNaN(s)) return { a: "seek", d: -s }; }
        m = cmds.match(/^(?:forward|skip)\s+(\w+)$/); if (m) { const s = parseTime(m[1]); if (!isNaN(s)) return { a: "seek", d: s }; }
        if (/^pause$/.test(cmds)) return { a: "pause" };
        if (/^(?:play|resume)$/.test(cmds)) return { a: "play" };
        if (/^(?:bookmark|mark|save)(?:\s+(?:this|here))?$/.test(cmds)) return { a: "bookmark" };
        if (/^(?:copy|share)\s*(?:link|url)?$/.test(cmds)) return { a: "copy" };
      }
    }
    return null;
  }

  // ═══ Executor ═══
  function exec(cmd) {
    if (cmd.a === "mic_off") { stopListening(); beep(); toast("Mic OFF"); showHud("Mic OFF", "info"); return; }
    const v = getVideo(); if (!v) { toast("No video found"); return; }
    beep();

    // Use speechStartTime for accurate loop boundaries when available
    const refTime = state.speechStartTime != null ? state.speechStartTime : v.currentTime;

    switch (cmd.a) {
      case "loop_last": { stopLoop(v, false); state.loop.start = Math.max(0, refTime - cmd.secs); state.loop.end = refTime; state.loop.ramp = !!cmd.ramp; startLoop(v, cmd.spd); const l = cmd.spd ? `Loop ${cmd.secs}s @ ${Math.round(cmd.spd * 100)}%${cmd.ramp ? " ↑" : ""}` : `Loop last ${cmd.secs}s`; toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break; }
      case "loop_range": { stopLoop(v, false); state.loop.start = cmd.start; state.loop.end = cmd.end; state.loop.ramp = false; startLoop(v, cmd.spd); const l = `Loop ${fmt(cmd.start)}–${fmt(cmd.end)}`; toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break; }
      case "adjust": { if (!state.loop.active) { toast("No active loop"); return; } state.loop.start = Math.max(0, state.loop.start + cmd.startDelta); state.loop.end = Math.max(state.loop.start + 1, state.loop.end + cmd.endDelta); v.currentTime = state.loop.start; const l = loopLabel(); toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break; }
      case "stop": { const w = state.loop.active; stopLoop(v, true); toast(w ? "Stopped" : "No loop"); setStatus("Listening", state.listening ? "listening" : "idle"); if (w) showHud("Stopped", "info"); break; }
      case "speed": { v.playbackRate = cmd.rate; const m = `Speed ${Math.round(cmd.rate * 100)}%`; toast(m); setStatus(state.loop.active ? loopLabel() : m, state.loop.active ? "loop" : "success"); showHud(m, "cmd"); break; }
      case "nudge": { const r = clamp(Math.round((v.playbackRate + cmd.d) * 100) / 100, 0.25, 4); v.playbackRate = r; const m = `Speed ${Math.round(r * 100)}%`; toast(m); setStatus(state.loop.active ? loopLabel() : m, state.loop.active ? "loop" : "success"); showHud(m, "cmd"); break; }
      case "seek": { v.currentTime = clamp(v.currentTime + cmd.d, 0, v.duration); const m = cmd.d < 0 ? `Back ${-cmd.d}s` : `Fwd ${cmd.d}s`; toast(m); showHud(m, "info"); break; }
      case "pause": v.pause(); toast("Paused"); setStatus("Paused", "idle"); showHud("Paused", "info"); break;
      case "play": v.play(); toast("Playing"); setStatus(state.loop.active ? loopLabel() : "Playing", state.loop.active ? "loop" : "listening"); break;
      case "bookmark": addBm(); break;
      case "copy": copyText(tsUrl(v.currentTime)); toast("Link copied"); showHud("Link copied", "info"); break;
    }
    state.speechStartTime = null;
  }

  // ═══ Loop Engine ═══
  function loopLabel() {
    const v = getVideo();
    const spd = Math.round((v?.playbackRate || 1) * 100);
    const rampArrow = state.loop.ramp ? " ↑" : "";
    return `#${state.loop.count} · ${fmt(state.loop.start)}–${fmt(state.loop.end)} · ${spd}%${rampArrow}`;
  }

  function startLoop(v, spd) {
    state.loop.preRate = v.playbackRate; if (spd) v.playbackRate = spd;
    state.loop.active = true; state.loop.count = 0;
    v.currentTime = state.loop.start; if (v.paused) v.play(); syncState();
    state.loop.interval = setInterval(() => {
      if (!state.loop.active) return; updateProgress();
      if (v.currentTime >= state.loop.end - 0.05 || v.currentTime < state.loop.start - 1) {
        const vol = v.volume; v.volume = Math.max(0, vol - 0.3); v.currentTime = state.loop.start;
        setTimeout(() => { v.volume = vol; }, 15);
        state.loop.count++;
        if (state.loop.ramp) { const r = clamp(v.playbackRate + RAMP_STEP, 0.1, 1); v.playbackRate = r; if (r >= 1) state.loop.ramp = false; }
        setStatus(loopLabel(), "loop");
      }
    }, LOOP_POLL_MS);
  }
  function stopLoop(v, restore) { state.loop.active = false; state.loop.ramp = false; clearInterval(state.loop.interval); state.loop.interval = null; if (restore && v) v.playbackRate = state.loop.preRate; state.loop.preRate = 1; state.loop.count = 0; updateProgress(); syncState(); }

  // ═══ Voice Control — Local Pipeline via Offscreen Document ═══
  function startListening() {
    state.listening = true;
    setStatus(state.vadReady ? "Listening" : "Loading models…", state.vadReady ? "listening" : "paused");
    const timeout = setTimeout(() => {
      if (state.listening && !state.vadReady) {
        setStatus("Voice unavailable", "error");
        toast("Could not start voice — try toggling off/on");
        state.listening = false;
        syncState();
      }
    }, 10000);
    chrome.runtime.sendMessage({ type: "start-voice" }, (r) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError || !r?.ok) {
        setStatus("Voice unavailable", "error");
        toast("Could not start voice");
        state.listening = false;
      }
    });
    syncState();
  }

  function stopListening() {
    state.listening = false;
    chrome.runtime.sendMessage({ type: "stop-voice" });
    setStatus("SetLoop", "idle");
    syncState();
  }

  // ═══ Push-to-Talk ═══
  document.addEventListener("keydown", (e) => { if (state.mode !== "ptt" || !state.listening || state.pttHeld) return; if (e.code !== state.pttKey) return; if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return; e.preventDefault(); state.pttHeld = true; setStatus("Speak now…", "listening"); showHud("Listening…", "interim"); chrome.runtime.sendMessage({ type: "start-voice" }); });
  document.addEventListener("keyup", (e) => { if (state.mode !== "ptt" || !state.pttHeld || e.code !== state.pttKey) return; e.preventDefault(); state.pttHeld = false; setTimeout(() => { if (!state.pttHeld) chrome.runtime.sendMessage({ type: "stop-voice" }); }, 600); setStatus("Hold ` to speak", state.loop.active ? "loop" : "idle"); });

  // ═══ Toggle ═══
  function toggle() {
    createOverlay();
    if (state.listening) { stopListening(); toast("Voice OFF"); }
    else { startListening(); toast(`Voice ON · ${state.mode === "ptt" ? "Hold \` to speak" : "Listening"}`); }
  }

  // ═══ Message Handler (validated) ═══
  const VALID_TYPES = new Set([
    "ping", "toggle", "status", "set-mode", "quick-bookmark",
    "get-bookmarks", "go-to-bookmark", "delete-bookmark",
    "vad-status", "vad-speech-start", "vad-speech-end", "vad-transcript",
  ]);

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (!msg || typeof msg.type !== "string" || !VALID_TYPES.has(msg.type)) return;

    switch (msg.type) {
      case "ping": respond({ pong: true }); break;
      case "toggle": toggle(); respond({ listening: state.listening, loopActive: state.loop.active, mode: state.mode }); break;
      case "status": respond({ listening: state.listening, loopActive: state.loop.active, mode: state.mode }); break;
      case "set-mode": {
        if (!["always", "ptt"].includes(msg.value)) break;
        state.mode = msg.value; saveCfg();
        if (state.listening) {
          if (state.mode === "always") {
            chrome.runtime.sendMessage({ type: "start-voice" });
            setStatus("Listening", "listening");
          } else {
            chrome.runtime.sendMessage({ type: "stop-voice" });
            setStatus("Hold ` to speak", "idle");
          }
        }
        toast(`Mode: ${state.mode === "ptt" ? "Push-to-Talk" : "Always On"}`);
        respond({ ok: true, mode: state.mode });
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

      // ── VAD events from offscreen (via background) ──
      case "vad-status": {
        if (msg.status === "ready") {
          state.vadReady = true;
          if (state.listening) setStatus("Listening", "listening");
        } else if (msg.status === "loading") {
          if (state.listening) setStatus("Loading models…", "paused");
        } else if (msg.status === "error") {
          state.vadReady = false;
          setStatus("Voice error", "error");
          toast(msg.message || "Model load failed");
        }
        break;
      }
      case "vad-speech-start": {
        const v = getVideo();
        // Buffer 0.5s before VAD fired — accounts for VAD detection lag
        // so "loop last 30" anchors to when user actually started speaking
        state.speechStartTime = v ? Math.max(0, v.currentTime - 0.5) : null;
        // Dip video volume while speaking — helps mic pick up voice over speakers
        if (v && !state._savedVol) {
          state._savedVol = v.volume;
          v.volume = Math.max(0, v.volume - 0.4);
        }
        // Subtle dot pulse — don't show text, don't distract from practice
        if (overlay) $("#vlDot").classList.add("vl-dot-hearing");
        break;
      }
      case "vad-speech-end": {
        // Restore volume, show brief processing pulse
        const ve = getVideo();
        if (ve && state._savedVol != null) {
          ve.volume = state._savedVol;
          state._savedVol = null;
        }
        if (overlay) {
          $("#vlDot").classList.remove("vl-dot-hearing");
          $("#vlDot").classList.add("vl-dot-processing");
        }
        break;
      }
      case "vad-transcript": {
        if (typeof msg.text !== "string") break;
        const text = msg.text.trim();
        if (!text) break;
        // Restore volume in case speech-end didn't fire
        const vt = getVideo();
        if (vt && state._savedVol != null) {
          vt.volume = state._savedVol;
          state._savedVol = null;
        }
        if (overlay) {
          $("#vlDot").classList.remove("vl-dot-hearing", "vl-dot-processing");
        }
        console.log(`[SetLoop] heard: "${text}"`);
        let cmd;
        try {
          cmd = parse(text);
        } catch (err) {
          console.error("[SetLoop] parse error:", err);
          cmd = null;
        }
        const fixed = whisperFix(text).toLowerCase().trim().replace(/[.!,?]+/g, "");
        if (!cmd) console.log(`[SetLoop] fixed: "${fixed}" → no match`);
        if (cmd) {
          console.log("[SetLoop] cmd:", cmd);
          exec(cmd);
        } else {
          // Not a command — brief red flash so user knows to repeat
          state.speechStartTime = null;
          if (overlay) {
            $("#vlDot").classList.add("vl-dot-miss");
            setTimeout(() => $("#vlDot")?.classList.remove("vl-dot-miss"), 800);
          }
        }
        break;
      }
    }
  });

  loadBm();
  console.log("[SetLoop] Ready — Alt+V to start");
})();
