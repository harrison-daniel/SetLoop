(() => {
  "use strict";
  if (window.__vl) return;
  window.__vl = true;

  const LOOP_POLL_MS = 50, TOAST_MS = 2200, MIN_CONFIDENCE = 0.45, RAMP_STEP = 0.05;

  const state = {
    listening: false, recognition: null,
    mode: "always", pttKey: "Backquote", pttHeld: false,
    loop: { active: false, start: 0, end: 0, interval: null, preRate: 1, count: 0, ramp: false },
    bookmarks: [], videoId: getVid(),
    quickActions: [
      { label: "⟳20s 75%", secs: 20, spd: 0.75 },
      { label: "⟳30s 50%", secs: 30, spd: 0.50 },
      { label: "■ Stop", secs: 0, spd: 0 },
    ],
    editing: false,
  };

  // ═══ Config ═══
  chrome?.storage?.local?.get("vl_cfg", (d) => {
    const c = d?.vl_cfg; if (!c) return;
    if (c.mode) state.mode = c.mode;
    if (c.pttKey) state.pttKey = c.pttKey;
    if (c.quickActions) state.quickActions = c.quickActions;
  });
  function saveCfg() { try { chrome?.storage?.local?.set({ vl_cfg: { mode: state.mode, pttKey: state.pttKey, quickActions: state.quickActions } }); } catch {} }
  function syncState() { try { chrome?.storage?.local?.set({ vl_state: { listening: state.listening, loopActive: state.loop.active, mode: state.mode } }); } catch {} }

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
  function loadBm() { chrome?.storage?.local?.get(`vl_bm_${state.videoId}`, (d) => { state.bookmarks = d?.[`vl_bm_${state.videoId}`] || []; }); }
  function saveBm() { chrome?.storage?.local?.set({ [`vl_bm_${state.videoId}`]: state.bookmarks }); }
  function addBm() { const v = getVideo(); if (!v) return; const t = v.currentTime; state.bookmarks.push({ id: Date.now(), time: t, label: fmt(t), speed: v.playbackRate, created: new Date().toISOString() }); saveBm(); beep(); toast(`Bookmarked ${fmt(t)}`); showHud(`Bookmarked ${fmt(t)}`, "info"); }

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

  // ═══ Quick Actions ═══
  function renderQA() {
    const el = $("#vlQuick"); if (!el) return;
    if (state.editing) {
      el.innerHTML = state.quickActions.filter(q => q.secs > 0).map((q, i) => `<div class="vl-qa-edit"><input type="number" class="vl-qa-input" value="${q.secs}" min="1" max="300" data-f="secs" data-i="${i}"><span class="vl-qa-at">s</span><input type="number" class="vl-qa-input" value="${Math.round(q.spd * 100)}" min="10" max="200" data-f="spd" data-i="${i}"><span class="vl-qa-at">%</span></div>`).join("") + `<button class="vl-qa vl-qa-save" id="vlSave">✓</button>`;
      document.getElementById("vlSave")?.addEventListener("click", (e) => { e.stopPropagation(); el.querySelectorAll(".vl-qa-input").forEach(inp => { const i = +inp.dataset.i, f = inp.dataset.f, qa = state.quickActions.filter(q => q.secs > 0)[i]; if (!qa) return; if (f === "secs") qa.secs = clamp(+inp.value, 1, 300); if (f === "spd") qa.spd = clamp(+inp.value / 100, 0.1, 4); qa.label = `⟳${qa.secs}s ${Math.round(qa.spd * 100)}%`; }); saveCfg(); state.editing = false; renderQA(); });
    } else {
      el.innerHTML = state.quickActions.map((q, i) => `<button class="vl-qa" data-i="${i}">${q.label}</button>`).join("");
      el.querySelectorAll(".vl-qa").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); const q = state.quickActions[+b.dataset.i]; if (!q) return; if (q.secs === 0 && q.spd === 0) exec({ a: "stop" }); else exec({ a: "loop_last", secs: q.secs, spd: q.spd }); }));
    }
  }
  function toggleEdit() { state.editing = !state.editing; const b = $("#vlEdit"); if (b) b.textContent = state.editing ? "✕" : "⚙"; renderQA(); }

  // ═══ HUD / Pill / Drag / Status ═══
  function posHud() {
    const h = document.getElementById("vlHud");
    const qaRow = document.querySelector(".vl-qa-row");
    const pill = document.getElementById("vlPill");
    if (!h) return;
    // Position below quick action buttons, or below pill if no QA visible
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
    // Mic icon: green when active, orange when paused, default when off
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

  // ═══ Parser — scans for commands within longer transcripts ═══
  function parse(raw) {
    let c = raw.toLowerCase().trim().replace(/[.!,?]+/g, "");
    c = c.replace(/loop\s+lasts?\s+/g, "loop last ");
    c = c.replace(/\s+i\s+think\s+/g, " at ");
    // SUBSTRING: "loop last N at X" anywhere in transcript
    let m = c.match(/loop\s+last\s+(\w+)\s*(?:(?:at|and)\s+(\w+)\s*(?:percent|%)?\s*(?:speed)?)?\s*(ramp(?:\s+up)?)?/);
    if (m) { const s = parseTime(m[1]); if (!isNaN(s) && s > 0 && s < 600) { let spd = null; if (m[2]) { let v = num(m[2]); if (!isNaN(v)) { spd = v > 4 ? v / 100 : v; spd = clamp(spd, 0.1, 4); } } return { a: "loop_last", secs: s, spd, ramp: !!m[3] }; } }
    // Loop range — substring
    m = c.match(/loop\s+(?:from\s+)?(\d+(?::\d+)?)\s+to\s+(\d+(?::\d+)?)(?:\s+(?:at|and)\s+(\w+)\s*(?:percent|%)?)?/);
    if (m) { const s = parseTime(m[1]), e = parseTime(m[2]); if (!isNaN(s) && !isNaN(e)) { let spd = null; if (m[3]) { let v = num(m[3]); if (!isNaN(v)) { spd = v > 4 ? v / 100 : v; spd = clamp(spd, 0.1, 4); } } return { a: "loop_range", start: s, end: e, spd }; } }
    // SHORT COMMANDS — exact match only (≤4 words to avoid false triggers)
    const stripped = c.replace(/^(?:.*\s)?loop\s+/, "").trim();
    if (c.split(/\s+/).length <= 4) {
      if (/^(?:mic\s+off|stop\s+listening|turn\s+off)$/.test(c) || /^(?:mic\s+off|stop\s+listening|turn\s+off)$/.test(stripped)) return { a: "mic_off" };
      if (/^(?:stop|cancel|end\s+loop|quit)(?:\s+loop(?:ing)?)?$/.test(stripped) || /^(?:stop|cancel|end\s+loop|quit)(?:\s+loop(?:ing)?)?$/.test(c)) return { a: "stop" };
      if (/^wider$/.test(stripped) || /^wider$/.test(c)) return { a: "adjust", startDelta: -2, endDelta: 0 };
      if (/^tighter$/.test(stripped) || /^tighter$/.test(c)) return { a: "adjust", startDelta: 2, endDelta: 0 };
      if (/^shift\s+back$/.test(stripped)) return { a: "adjust", startDelta: -2, endDelta: -2 };
      if (/^shift\s+forward$/.test(stripped)) return { a: "adjust", startDelta: 2, endDelta: 2 };
      m = stripped.match(/^(?:set\s+)?speed\s+(?:to\s+)?(\w+)(?:\s*(?:percent|%))?$/); if (m) { let r = num(m[1]); if (isNaN(r)) return null; if (r > 4) r /= 100; return { a: "speed", rate: clamp(r, 0.1, 4) }; }
      if (/^(?:normal\s+speed|reset(?:\s+speed)?)$/.test(stripped)) return { a: "speed", rate: 1 };
      if (/^(?:slow(?:er)?|slow\s*down)$/.test(stripped) || /^(?:slow(?:er)?|slow\s*down)$/.test(c)) return { a: "nudge", d: -0.25 };
      if (/^(?:fast(?:er)?|speed\s*up)$/.test(stripped) || /^(?:fast(?:er)?|speed\s*up)$/.test(c)) return { a: "nudge", d: 0.25 };
      m = stripped.match(/^back\s+(\w+)$/); if (m) { const s = parseTime(m[1]); if (!isNaN(s)) return { a: "seek", d: -s }; }
      m = stripped.match(/^(?:forward|skip)\s+(\w+)$/); if (m) { const s = parseTime(m[1]); if (!isNaN(s)) return { a: "seek", d: s }; }
      if (/^pause$/.test(stripped) || /^pause$/.test(c)) return { a: "pause" };
      if (/^(?:play|resume)$/.test(stripped) || /^(?:play|resume)$/.test(c)) return { a: "play" };
      if (/^(?:bookmark|mark|save)(?:\s+(?:this|here))?$/.test(stripped) || /^(?:bookmark|mark|save)(?:\s+(?:this|here))?$/.test(c)) return { a: "bookmark" };
      if (/^(?:copy|share)\s*(?:link|url)?$/.test(stripped) || /^(?:copy|share)\s*(?:link|url)?$/.test(c)) return { a: "copy" };
    }
    return null;
  }

  // ═══ Executor ═══
  function exec(cmd) {
    if (cmd.a === "mic_off") { stopListening(); beep(); toast("Mic OFF"); showHud("Mic OFF", "info"); return; }
    const v = getVideo(); if (!v) { toast("No video found"); return; }
    beep();
    switch (cmd.a) {
      case "loop_last": { stopLoop(v, false); state.loop.start = Math.max(0, v.currentTime - cmd.secs); state.loop.end = v.currentTime; state.loop.ramp = !!cmd.ramp; startLoop(v, cmd.spd); const l = cmd.spd ? `Loop ${cmd.secs}s @ ${Math.round(cmd.spd * 100)}%${cmd.ramp ? " ↑" : ""}` : `Loop last ${cmd.secs}s`; toast(l); setStatus(l, "loop"); showHud(l, "cmd"); break; }
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

  // ═══ Speech Recognition — non-continuous, fast restart ═══
  let errN = 0;

  function startListening() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Not supported"); return; }
    state.listening = true; errN = 0;
    setStatus("Listening", "listening");
    if (state.mode === "always") launchSR();
    syncState();
  }
  function stopListening() {
    state.listening = false;
    if (state.recognition) { try { state.recognition.abort(); } catch {} }
    state.recognition = null; setStatus("SetLoop", "idle");
  }

  let startFailCount = 0; // Track consecutive launches where onstart never fires

  function launchSR() {
    if (state.recognition) { try { state.recognition.abort(); } catch {} }
    state.recognition = null; if (!state.listening) return;

    // If we've failed to start 3+ times, Chrome is blocking us — stop retrying
    if (startFailCount >= 3) {
      setStatus("Paused · toggle 🎙 off/on", "paused");
      console.log("[VL] SR blocked — click mic icon to resume");
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition, r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = "en-US"; r.maxAlternatives = 1;
    state.recognition = r;
    let started = false;

    r.onstart = () => {
      errN = 0; started = true; startFailCount = 0;
    };
    r.onresult = (e) => {
      errN = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], t = res[0].transcript.trim(), conf = res[0].confidence;
        if (!t) continue;
        if (!res.isFinal) { if (t.length < 50) showInterimOnPill(t); if (state.mode === "ptt") showHud(t, "interim"); continue; }
        if (conf > 0 && conf < MIN_CONFIDENCE) { console.log(`[VL] skip (${(conf * 100).toFixed(0)}%): "${t}"`); continue; }
        console.log(`[VL] heard (${conf > 0 ? (conf * 100).toFixed(0) + "%" : "–"}): "${t}"`);
        const cmd = parse(t); if (cmd) { console.log("[VL] cmd:", cmd); exec(cmd); }
      }
    };
    r.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { setStatus("Mic blocked", "error"); toast("Mic blocked"); state.listening = false; state.recognition = null; syncState(); return; } errN++; };
    r.onend = () => {
      if (!state.listening) return;
      if (state.mode === "ptt" && !state.pttHeld) return;
      // If onstart never fired, count it as a failure
      if (!started) startFailCount++;
      const d = errN > 3 ? Math.min(300 * Math.pow(1.5, errN), 3000) : 150;
      setTimeout(launchSR, d); // launchSR will check startFailCount and bail if needed
    };

    try { r.start(); } catch { if (state.listening) setTimeout(launchSR, 1000); }
  }

  // ═══ Push-to-Talk ═══
  document.addEventListener("keydown", (e) => { if (state.mode !== "ptt" || !state.listening || state.pttHeld) return; if (e.code !== state.pttKey) return; if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return; e.preventDefault(); state.pttHeld = true; setStatus("Speak now…", "listening"); showHud("Listening…", "interim"); launchSR(); });
  document.addEventListener("keyup", (e) => { if (state.mode !== "ptt" || !state.pttHeld || e.code !== state.pttKey) return; e.preventDefault(); state.pttHeld = false; setTimeout(() => { if (!state.pttHeld && state.recognition) try { state.recognition.stop(); } catch {} }, 600); setStatus("Hold ` to speak", state.loop.active ? "loop" : "idle"); });

  // ═══ Focus recovery — only mic icon click works ═══
  document.addEventListener("visibilitychange", () => {
    if (!state.listening || state.mode !== "always") return;
    if (document.hidden) {
      // Tab going hidden — show paused state immediately
      setStatus("Paused · toggle 🎙 off/on", "paused");
    }
    // Tab visible — try auto-restart (works if user clicked the tab itself)
    if (!document.hidden) {
      startFailCount = 0;
      if (state.recognition) { try { state.recognition.abort(); } catch {} }
      state.recognition = null; errN = 0;
      launchSR();
    }
  });

  // ═══ Toggle ═══
  function toggle() {
    createOverlay();
    startFailCount = 0;
    if (state.listening) { stopListening(); toast("Voice OFF"); }
    else { startListening(); toast(`Voice ON · ${state.mode === "ptt" ? "Hold ` to speak" : "Listening"}`); }
  }

  // ═══ Messages ═══
  chrome.runtime.onMessage.addListener((msg, _, respond) => {
    switch (msg.type) {
      case "ping": respond({ pong: true }); break;
      case "toggle": toggle(); respond({ listening: state.listening, loopActive: state.loop.active, mode: state.mode }); break;
      case "status": {
        if (state.listening && state.mode === "always" && !state.recognition) launchSR();
        respond({ listening: state.listening, loopActive: state.loop.active, mode: state.mode }); break;
      }
      case "set-mode": {
        state.mode = msg.value; saveCfg();
        if (state.listening) { if (state.recognition) { try { state.recognition.abort(); } catch {} } state.recognition = null; if (state.mode === "always") launchSR(); setStatus(state.mode === "ptt" ? "Hold ` to speak" : "Listening", state.mode === "always" ? "listening" : "idle"); }
        toast(`Mode: ${state.mode === "ptt" ? "Push-to-Talk" : "Always On"}`); respond({ ok: true, mode: state.mode }); break;
      }
      case "quick-bookmark": createOverlay(); addBm(); respond({ ok: true }); break;
      case "get-bookmarks": respond({ bookmarks: state.bookmarks, videoId: state.videoId }); break;
      case "go-to-bookmark": { const v = getVideo(); if (v && typeof msg.time === "number") { v.currentTime = msg.time; toast(`→ ${fmt(msg.time)}`); } respond({ ok: true }); break; }
      case "delete-bookmark": state.bookmarks = state.bookmarks.filter(b => b.id !== msg.id); saveBm(); respond({ ok: true }); break;
    }
  });

  loadBm();
  console.log("[SetLoop] Ready — Alt+V to start");
})();
