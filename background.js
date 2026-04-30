const injected = new Set();
let offscreenReady = false;

// ── Storage: session for ephemeral state ─────────────────────────────
chrome.storage.session.setAccessLevel({
  accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
});

// ── First Install → open onboarding ──────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: "onboarding.html" });
  }
});

// ── Offscreen Document Management ────────────────────────────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Local voice activity detection and speech recognition via ONNX models",
  });
}

async function closeOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
  offscreenReady = false;
}

// ── Keyboard Shortcuts ───────────────────────────────────────────────
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

// ── Message Routing ──────────────────────────────────────────────────
const VALID_POPUP = ["inject-and-toggle", "inject-and-status"];
const VALID_CONTENT = ["state-update", "start-voice", "stop-voice", "set-sensitivity"];
const VALID_OFFSCREEN = ["vad-status", "vad-speech-start", "vad-transcript"];

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!msg || typeof msg.type !== "string") return;

  // Messages from popup
  if (VALID_POPUP.includes(msg.type)) {
    handlePopupMessage(msg, respond);
    return true;
  }

  // Messages from content script → forward to offscreen or handle locally
  if (VALID_CONTENT.includes(msg.type)) {
    handleContentMessage(msg, sender, respond);
    return true;
  }

  // Messages from offscreen → forward to active tab's content script
  if (VALID_OFFSCREEN.includes(msg.type)) {
    handleOffscreenMessage(msg);
    return false;
  }
});

async function handlePopupMessage(msg, respond) {
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
}

async function handleContentMessage(msg, sender, respond) {
  // Badge updates
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
    return;
  }

  // Start voice pipeline → ensure offscreen, then forward
  if (msg.type === "start-voice") {
    try {
      await ensureOffscreen();
      chrome.runtime.sendMessage({ type: "start-pipeline" });
      respond({ ok: true });
    } catch (err) {
      respond({ ok: false, error: err.message });
    }
    return;
  }

  // Stop voice pipeline → forward to offscreen, optionally close it
  if (msg.type === "stop-voice") {
    chrome.runtime.sendMessage({ type: "stop-pipeline" });
    respond({ ok: true });
    return;
  }

  // Sensitivity change → forward to offscreen
  if (msg.type === "set-sensitivity") {
    chrome.runtime.sendMessage({ type: "set-sensitivity", threshold: msg.threshold });
    respond({ ok: true });
    return;
  }
}

async function handleOffscreenMessage(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Forward VAD events to the content script
  chrome.tabs.sendMessage(tab.id, msg, () => {
    if (chrome.runtime.lastError) { /* tab may have closed */ }
  });
}

// ── On-demand content script injection ───────────────────────────────
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
