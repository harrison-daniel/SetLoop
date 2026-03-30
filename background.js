// ═══════════════════════════════════════════════════════════════════
// SetLoop — Background Service Worker
// Lightweight: wakes only for shortcuts, messages, and install event.
// Injects content script ON DEMAND — zero footprint on unused pages.
// ═══════════════════════════════════════════════════════════════════

const injected = new Set();

// ── First Install → open onboarding ─────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: "onboarding.html" });
  }
});

// ── Keyboard Shortcuts ──────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await ensure(tab.id);

  if (command === "toggle-voice") {
    chrome.tabs.sendMessage(tab.id, { type: "toggle" });
  } else if (command === "quick-bookmark") {
    chrome.tabs.sendMessage(tab.id, { type: "quick-bookmark" });
  }
});

// ── Messages from popup ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === "inject-and-toggle" || msg.type === "inject-and-status") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return respond({ listening: false, loopActive: false, injected: false });
      try {
        await ensure(tab.id);
        const action = msg.type === "inject-and-toggle" ? "toggle" : "status";
        chrome.tabs.sendMessage(tab.id, { type: action }, (r) => {
          if (chrome.runtime.lastError) {
            respond({ listening: false, loopActive: false, injected: false });
          } else {
            respond({ ...r, injected: true });
          }
        });
      } catch {
        respond({ listening: false, loopActive: false, injected: false });
      }
    })();
    return true;
  }

  // Badge updates from content script
  if (msg.type === "state-update" && sender.tab) {
    const id = sender.tab.id;
    if (msg.loopActive) {
      chrome.action.setBadgeText({ text: "⟳", tabId: id });
      chrome.action.setBadgeBackgroundColor({ color: "#F59E42", tabId: id });
    } else if (msg.listening) {
      chrome.action.setBadgeText({ text: "●", tabId: id });
      chrome.action.setBadgeBackgroundColor({ color: "#4ADE80", tabId: id });
    } else {
      chrome.action.setBadgeText({ text: "", tabId: id });
    }
  }
});

// ── On-demand injection ─────────────────────────────────────────────
async function ensure(tabId) {
  if (injected.has(tabId)) return;
  try {
    await new Promise((ok, fail) => {
      chrome.tabs.sendMessage(tabId, { type: "ping" }, (r) => {
        chrome.runtime.lastError ? fail() : ok(r);
      });
    });
    injected.add(tabId);
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    injected.add(tabId);
  }
}

chrome.tabs.onRemoved.addListener((id) => injected.delete(id));
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading") injected.delete(id);
});
