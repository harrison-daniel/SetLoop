const sw       = document.getElementById("sw");
const swStrict  = document.getElementById("swStrict");
const swDuck    = document.getElementById("swDuck");
const btnAlways = document.getElementById("modeAlways");
const btnPtt    = document.getElementById("modePtt");
const modeLabel = document.getElementById("modeLabel");
const modeSub   = document.getElementById("modeSub");
const dot       = document.getElementById("dot");
const stxt      = document.getElementById("stxt");
const bms       = document.getElementById("bms");

const MODE_INFO = {
  always: { label: "Always On",     sub: "Mic stays on — speak commands anytime" },
  ptt:    { label: "Push-to-Talk",  sub: "Hold ` key, speak, release" },
};

let currentVideoId = null;

function msg(data) {
  return new Promise(r => chrome.runtime.sendMessage(data, resp => {
    if (chrome.runtime.lastError) r(null); else r(resp);
  }));
}

function updateModeUI(mode) {
  [btnAlways, btnPtt].forEach(b => b.classList.remove("mode-active"));
  ({ always: btnAlways, ptt: btnPtt }[mode])?.classList.add("mode-active");
  const info = MODE_INFO[mode] || MODE_INFO.always;
  modeLabel.textContent = info.label;
  modeSub.textContent   = info.sub;
}

function ui(listening, looping, overlayActive) {
  sw.checked = !!overlayActive;
  dot.className = "st-dot" + (looping ? " lp" : listening ? " on" : overlayActive ? " on" : "");
  stxt.textContent = looping ? "Loop active" : listening ? "Listening…" : overlayActive ? "Active — tap 🎙 for voice" : "Inactive";
}

function setUnsupported(pageKind) {
  sw.disabled = true;
  dot.className = "st-dot";
  if (pageKind === "youtube-shorts") stxt.textContent = "Not supported on Shorts";
  else if (pageKind === "no-video")  stxt.textContent = "No video on this page";
  else                               stxt.textContent = "Open a page with video";
}

chrome.storage.onChanged.addListener((changes) => {
  const s = changes.vl_state?.newValue;
  if (!s) return;
  ui(s.listening, s.loopActive, s.overlayActive);
  if (s.mode) updateModeUI(s.mode);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runInPage(method) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  await msg({ type: "popup-status" });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "ISOLATED",
      func: (m) => {
        const sl = window.__setloop;
        if (!sl) return { error: "bridge-missing" };
        return sl[m]?.() || sl.status?.();
      },
      args: [method],
    });
    return results?.[0]?.result || null;
  } catch { return null; }
}

async function init() {
  const r = await msg({ type: "popup-status" });
  if (!r?.injected) {
    stxt.textContent = "Open a page with video";
    sw.disabled = true;
    loadBm(); // show saved bookmarks even without active content script
    return;
  }
  if (!r.supported) { setUnsupported(r.pageKind); }
  if (r.mode) updateModeUI(r.mode);
  swStrict.checked  = !!r.strict;
  swDuck.checked    = !!r.duck;
  currentVideoId    = r.videoId || null;
  ui(r.listening, r.loopActive, r.overlayActive);
  loadBm();
}

sw.addEventListener("change", async () => {
  const method = sw.checked ? "activateOverlay" : "deactivateOverlay";
  const r = await runInPage(method);
  if (r && !r.error) {
    ui(r.listening, r.loopActive, r.overlayActive);
    if (r.mode) updateModeUI(r.mode);
  } else {
    sw.checked = !sw.checked;
  }
});

async function setMode(mode) {
  const tab = await activeTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "set-mode", value: mode }, (r) => {
    if (r?.mode) updateModeUI(r.mode);
  });
}
btnAlways.addEventListener("click", () => setMode("always"));
btnPtt.addEventListener("click",    () => setMode("ptt"));

swStrict.addEventListener("change", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "set-strict", value: swStrict.checked },
    () => void chrome.runtime.lastError);
});

swDuck.addEventListener("change", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "set-duck", value: swDuck.checked },
    () => void chrome.runtime.lastError);
});

// Read ALL bookmarks directly from storage — works without active content script,
// shows bookmarks from every video the user has visited.
function loadBm() {
  chrome.storage.local.get(null, (all) => {
    const list = [];
    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith("vl_bm_")) continue;
      if (Array.isArray(val)) {
        for (const b of val) {
          if (b && typeof b.id === "number" && typeof b.time === "number" && b.time >= 0) {
            list.push(b);
          }
        }
      }
    }
    list.sort((a, b) => (b.created || "") > (a.created || "") ? 1 : -1);
    render(list);
  });
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function saveNote(b, note) {
  const key = `vl_bm_${b.videoId}`;
  if (!b.videoId) return;
  chrome.storage.local.get(key, (d) => {
    const arr     = Array.isArray(d[key]) ? d[key] : [];
    const updated = arr.map(x => x.id === b.id ? { ...x, note } : x);
    chrome.storage.local.set({ [key]: updated });
  });
}

function render(list) {
  bms.textContent = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className   = "bm-empty";
    empty.textContent = 'None yet — say "bookmark" or press Alt+B';
    bms.appendChild(empty);
    return;
  }
  for (const b of list) {
    const onOtherVideo = currentVideoId && b.videoId && b.videoId !== currentVideoId;

    const item = document.createElement("div");
    item.className = "bm-item" + (onOtherVideo ? " bm-item-ext" : "");

    // Time column: loop start–end if loop data exists, else bookmark timestamp
    const timeEl = document.createElement("span");
    timeEl.className   = "bm-time";
    timeEl.textContent = (b.loopStart != null && b.loopEnd != null)
      ? `${fmt(b.loopStart)}–${fmt(b.loopEnd)}`
      : fmt(b.time);

    // Info column
    const info = document.createElement("div");
    info.className = "bm-info";

    const labelEl = document.createElement("span");
    labelEl.className   = "bm-label";
    labelEl.textContent = b.note || b.videoTitle || fmt(b.time);
    info.appendChild(labelEl);

    if (b.loopStart != null && b.loopEnd != null) {
      const spd   = Math.round((b.speed || 1) * 100);
      const badge = document.createElement("span");
      badge.className   = "bm-loop";
      badge.textContent = `${spd}%${b.ramp ? " ↑" : ""}`;
      info.appendChild(badge);
    }

    // Edit button (pencil — appears on hover)
    const editBtn = document.createElement("button");
    editBtn.className = "bm-edit";
    editBtn.title     = "Edit label";
    editBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className   = "bm-del";
    delBtn.title       = "Remove";
    delBtn.textContent = "×";

    item.append(timeEl, info, editBtn, delBtn);
    bms.appendChild(item);

    // Navigate on click — always open in new tab when we have a URL
    item.addEventListener("click", async (e) => {
      if (e.target.closest(".bm-del,.bm-edit")) return;
      if (b.videoUrl) {
        await new Promise(res => chrome.storage.local.set({ vl_pending_restore: b }, res));
        // Append timestamp so YouTube starts near the loop (content script will fine-tune)
        let url = b.videoUrl;
        if (b.loopStart != null) {
          try { const u = new URL(url); u.searchParams.set("t", `${Math.floor(b.loopStart)}s`); url = u.toString(); } catch {}
        }
        chrome.tabs.create({ url });
        window.close();
        return;
      }
      // Fallback for old bookmarks without a stored URL — seek on current tab
      const tab = await activeTab();
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "go-to-bookmark", id: b.id, time: b.time });
    });

    // Inline note edit
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const inp = document.createElement("input");
      inp.className   = "bm-note-input";
      inp.value       = b.note || "";
      inp.placeholder = b.videoTitle || "Add a label…";
      info.replaceChild(inp, labelEl);
      inp.focus();
      const save = () => {
        const note = inp.value.trim();
        b.note = note;
        saveNote(b, note);
        labelEl.textContent = note || b.videoTitle || fmt(b.time);
        if (inp.parentNode === info) info.replaceChild(labelEl, inp);
      };
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter")  { inp.blur(); }
        if (ev.key === "Escape") { if (inp.parentNode === info) info.replaceChild(labelEl, inp); }
        ev.stopPropagation();
      });
    });

    // Delete directly from storage
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const storageKey = `vl_bm_${b.videoId || currentVideoId}`;
      chrome.storage.local.get(storageKey, (d) => {
        const arr     = Array.isArray(d[storageKey]) ? d[storageKey] : [];
        const updated = arr.filter(x => x.id !== b.id);
        chrome.storage.local.set({ [storageKey]: updated }, () => {
          if (!onOtherVideo) {
            activeTab().then(tab => {
              if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "delete-bookmark", id: b.id },
                () => void chrome.runtime.lastError);
            });
          }
          loadBm();
        });
      });
    });
  }
}

init();
