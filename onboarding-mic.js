// Onboarding: one-time microphone grant. The button triggers
// getUserMedia on this page (extension origin) so Chrome remembers the
// grant. The actual SpeechRecognition host runs in the content script on
// video sites, which uses the site's own mic grant — so users will still
// see a one-time mic prompt the first time on each site (youtube.com,
// vimeo.com, etc.). This step surfaces the feature clearly so users
// understand what's about to happen.

const btn = document.getElementById("grantMic");
const status = document.getElementById("micStatus");

if (btn) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Requesting microphone…";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      status.textContent = "Microphone granted. You're ready to go.";
      btn.textContent = "Granted";
      btn.classList.add("granted");
    } catch (err) {
      btn.disabled = false;
      if (err.name === "NotAllowedError") {
        status.textContent = "Permission denied. Click the mic icon in the address bar to allow.";
      } else {
        status.textContent = "Error: " + (err.message || err.name);
      }
    }
  });
}
