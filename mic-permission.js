document.getElementById("grant").addEventListener("click", async () => {
  const status = document.getElementById("status");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    status.className = "done";
    status.textContent = "Granted! You can close this tab.";
    chrome.runtime.sendMessage({ type: "mic-permission-granted" }, () => {
      if (chrome.runtime.lastError) { /* ok */ }
    });
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    status.className = "err";
    status.textContent = "Permission denied. Please click Allow when prompted.";
  }
});
