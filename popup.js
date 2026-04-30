const sw = document.getElementById("sw");
const swStrict = document.getElementById("swStrict");
const swDuck = document.getElementById("swDuck");
const btnAlways = document.getElementById("modeAlways");
const btnPtt = document.getElementById("modePtt");
const modeLabel = document.getElementById("modeLabel");
const modeSub = document.getElementById("modeSub");
const dot = document.getElementById("dot");
const stxt = document.getElementById("stxt");
const bms = document.getElementById("bms");

const MODE_INFO = {
  always: { label: "Always On", sub: "Mic stays on — speak commands anytime" },
  ptt:    { label: "Push-to-Talk", sub: "Hold ` key, speak, release" },
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
  sw.checked = !!listening;
  dot.className = "st-dot" + (looping ? " lp" : listening ? " on" : "");
  stxt.textContent = looping ? "Loop active" : listening ? "Listening…" : "Inactive";
}

function setUnsupported(pageKind) {
  sw.disabled = true;
  dot.className = "st-dot";
  if (pageKind === "youtube-shorts") stxt.textContent = "Not supported on Shorts";
  else if (pageKind === "no-video") stxt.textContent = "No video on this page";
  else stxt.textContent = "Open a page with video";
}

chrome.storage.onChanged.addListener((changes) => {
  const s = changes.vl_state?.newValue;
  if (!s) return;
  ui(s.listening, s.loopActive);
  if (s.mode) updateModeUI(s.mode);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// chrome.scripting.executeScript from a popup click preserves user activation
// into the content-script isolated world. That activation is what lets
// webkitSpeechRecognition.start() succeed on first use.
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
    return;
  }
  if (!r.supported) { setUnsupported(r.pageKind); return; }
  if (r.mode) updateModeUI(r.mode);
  swStrict.checked = !!r.strict;
  swDuck.checked = !!r.duck;
  ui(r.listening, r.loopActive);
  loadBm();
}

sw.addEventListener("change", async () => {
  const r = await runInPage("toggle");
  if (r && !r.error) {
    ui(r.listening, r.loopActive);
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
btnPtt.addEventListener("click", () => setMode("ptt"));

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

async function loadBm() {
  const tab = await activeTab();
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
    const item = document.createElement("div"); item.className = "bm-item";
    const timeEl = document.createElement("span"); timeEl.className = "bm-time"; timeEl.textContent = `${m}:${s}`;
    const labelEl = document.createElement("span"); labelEl.className = "bm-label";
    labelEl.textContent = typeof b.label === "string" ? b.label : `${m}:${s}`;
    const delBtn = document.createElement("button"); delBtn.className = "bm-del"; delBtn.title = "Remove"; delBtn.textContent = "×";
    item.append(timeEl, labelEl, delBtn);
    bms.appendChild(item);
    item.addEventListener("click", async (e) => {
      if (e.target.closest(".bm-del")) return;
      const tab = await activeTab();
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "go-to-bookmark", time: b.time });
    });
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tab = await activeTab();
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "delete-bookmark", id: b.id }, () => loadBm());
    });
  }
}

init();
