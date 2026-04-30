// SetLoop — Background service worker.
//
// Thin message router. SpeechRecognition runs in the content script
// (activation transferred from popup click via chrome.scripting.executeScript).
// This worker: injects content + overlay CSS on demand, forwards popup
// toggles/queries to the active tab, drives the toolbar badge, and wires
// Alt+V / Alt+B keyboard commands.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.tabs.create({ url: "onboarding.html" });
});

// Keyboard commands ──────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!(await ensureContentScript(tab.id))) return;

  if (command === "toggle-voice") {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } else if (command === "quick-bookmark") {
    chrome.tabs.sendMessage(tab.id, { type: "quick-bookmark" });
  }
});

// Message routing ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== "string") return;
  if (sender.id !== chrome.runtime.id) return;

  switch (msg.type) {
    case "popup-status": {
      (async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { respond({ injected: false }); return; }
        const ok = await ensureContentScript(tab.id);
        if (!ok) { respond({ injected: false }); return; }
        chrome.tabs.sendMessage(tab.id, { type: "status" }, (r) => {
          if (chrome.runtime.lastError) respond({ injected: false });
          else respond({ ...r, injected: true });
        });
      })();
      return true;
    }

    case "state-update": {
      const id = sender.tab?.id;
      if (!id) return false;
      if (msg.loopActive) {
        chrome.action.setBadgeText({ text: "L", tabId: id });
        chrome.action.setBadgeBackgroundColor({ color: "#F59E42", tabId: id });
      } else if (msg.listening) {
        chrome.action.setBadgeText({ text: "ON", tabId: id });
        chrome.action.setBadgeBackgroundColor({ color: "#4ADE80", tabId: id });
      } else {
        chrome.action.setBadgeText({ text: "", tabId: id });
      }
      return false;
    }
  }
});

// Content script ensure / ping ───────────────────────────────────────

async function ensureContentScript(tabId) {
  if (await ping(tabId)) return true;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch { return false; }
}

function ping(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "ping" }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch { resolve(false); }
  });
}
