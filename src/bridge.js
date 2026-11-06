// API Lens bridge — runs in the ISOLATED world. Relays capture entries from
// the page (MAIN world) to the service worker, and recording state back down.
(function () {
  if (window.__apiLensBridge) return;
  window.__apiLensBridge = true;

  var recording = false;

  function pushControl() {
    window.postMessage({ __apiLens: true, kind: "control", recording: recording }, "*");
  }

  function refreshState() {
    try {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, function (res) {
        if (chrome.runtime.lastError) return;
        if (res && typeof res.recording === "boolean") {
          recording = res.recording;
          pushControl();
        }
      });
    } catch (e) { /* extension context can vanish on reload */ }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || e.data.__apiLens !== true) return;
    if (e.data.kind === "entry" && e.data.entry) {
      try {
        chrome.runtime.sendMessage({ type: "ENTRY", entry: e.data.entry });
      } catch (err) { /* ignore */ }
    } else if (e.data.kind === "ready") {
      refreshState();
    }
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === "SET_RECORDING") {
      recording = !!msg.recording;
      pushControl();
    }
  });

  refreshState();
})();
