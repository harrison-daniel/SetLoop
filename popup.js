const sw = document.getElementById("sw");
const btnAlways = document.getElementById("modeAlways");
const btnPtt = document.getElementById("modePtt");
const modeLabel = document.getElementById("modeLabel");
const modeSub = document.getElementById("modeSub");
const dot = document.getElementById("dot");
const stxt = document.getElementById("stxt");
const bms = document.getElementById("bms");

const MODE_INFO = {
  always: { label: "Always On", sub: "Mic stays on — speak commands anytime" },
  ptt: { label: "Push-to-Talk", sub: "Hold ` key, speak, release" },
};

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
  modeSub.textContent = info.sub;
}

function ui(listening, looping) {
  sw.checked = listening;
  dot.className = "st-dot" + (looping ? " lp" : listening ? " on" : "");
  stxt.textContent = looping ? "Loop active" : listening ? "Listening…" : "Inactive";
}

// Sync state from storage.session (or storage.local fallback)
chrome.storage.onChanged.addListener((changes, area) => {
  const stateChange = changes.vl_state;
  if (stateChange) {
    const s = stateChange.newValue;
    if (s) { ui(s.listening, s.loopActive); if (s.mode) updateModeUI(s.mode); }
  }
});

async function init() {
  try {
    const r = await msg({ type: "inject-and-status" });
    if (r) {
      if (r.mode) updateModeUI(r.mode);
      ui(r.listening, r.loopActive);
      if (r.injected) loadBm();
    }
  } catch {
    stxt.textContent = "Open a page with video";
    sw.disabled = true;
  }
}

sw.addEventListener("change", async () => {
  const r = await msg({ type: "inject-and-toggle" });
  if (r) { ui(r.listening, r.loopActive); if (r.mode) updateModeUI(r.mode); }
});

async function setMode(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "set-mode", value: mode }, (r) => {
      if (r?.mode) updateModeUI(r.mode);
    });
  }
}
btnAlways.addEventListener("click", () => setMode("always"));
btnPtt.addEventListener("click", () => setMode("ptt"));

// ═══ Bookmarks (DOM-based, no innerHTML for dynamic data) ═══
async function loadBm() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "get-bookmarks" }, (r) => {
    if (chrome.runtime.lastError || !r) return;
    render(r.bookmarks || []);
  });
}

function render(list) {
  bms.textContent = "";

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "bm-empty";
    empty.textContent = 'None yet — say "bookmark" or press Alt+B';
    bms.appendChild(empty);
    return;
  }

  for (const b of list) {
    const m = Math.floor(b.time / 60);
    const s = Math.floor(b.time % 60).toString().padStart(2, "0");

    const item = document.createElement("div");
    item.className = "bm-item";

    const timeEl = document.createElement("span");
    timeEl.className = "bm-time";
    timeEl.textContent = `${m}:${s}`;

    const labelEl = document.createElement("span");
    labelEl.className = "bm-label";
    labelEl.textContent = typeof b.label === "string" ? b.label : `${m}:${s}`;

    const delBtn = document.createElement("button");
    delBtn.className = "bm-del";
    delBtn.title = "Remove";
    delBtn.textContent = "×";

    item.append(timeEl, labelEl, delBtn);
    bms.appendChild(item);

    item.addEventListener("click", async (e) => {
      if (e.target.closest(".bm-del")) return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "go-to-bookmark", time: b.time });
    });

    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "delete-bookmark", id: b.id }, () => loadBm());
    });
  }
}

init();
