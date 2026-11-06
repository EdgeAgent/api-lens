// API Lens service worker — owns per-tab recording sessions.
// Entries live in memory + chrome.storage.local (debounced) so a worker
// restart doesn't lose a session. Nothing leaves the browser.

const MAX_ENTRIES_PER_TAB = 300;
const STORE_KEY = "apilens_sessions_v1";
const SAVED_KEY = "apilens_saved_v1";

const sessions = new Map(); // tabId -> { recording:boolean, entries:[], startedAt }
let storeTimer = null;

function getSession(tabId) {
  if (!sessions.has(tabId)) sessions.set(tabId, { recording: false, entries: [], startedAt: Date.now() });
  return sessions.get(tabId);
}

async function restore() {
  try {
    const data = await chrome.storage.local.get(STORE_KEY);
    const saved = data[STORE_KEY] || {};
    for (const [tabId, s] of Object.entries(saved)) {
      sessions.set(Number(tabId), { recording: false, entries: s.entries || [], startedAt: s.startedAt || Date.now() });
    }
  } catch { /* fresh start is fine */ }
}
const restored = restore();

function persist() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(async () => {
    const out = {};
    for (const [tabId, s] of sessions.entries()) {
      if (s.entries.length) out[tabId] = { entries: s.entries, startedAt: s.startedAt };
    }
    try { await chrome.storage.local.set({ [STORE_KEY]: out }); } catch { /* quota: next write retries */ }
  }, 800);
}

async function badge(tabId) {
  const s = sessions.get(tabId);
  try {
    if (!s || (!s.recording && s.entries.length === 0)) {
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    await chrome.action.setBadgeText({ tabId, text: String(s.entries.length) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: s.recording ? "#d13438" : "#5b6b7c" });
    await chrome.action.setTitle({
      tabId,
      title: s.recording
        ? `API Lens — recording (${s.entries.length} captured)`
        : `API Lens — ${s.entries.length} captured (not recording)`,
    });
  } catch { /* tab may be gone */ }
}

function notifyUi(tabId) {
  chrome.runtime.sendMessage({ type: "SESSION_UPDATED", tabId }).catch(() => {});
}

async function setRecording(tabId, recording) {
  await restored;
  const s = getSession(tabId);
  s.recording = recording;
  if (recording && s.entries.length === 0) s.startedAt = Date.now();
  try { await chrome.tabs.sendMessage(tabId, { type: "SET_RECORDING", recording }); } catch { /* page may not have the bridge yet */ }
  await badge(tabId);
  notifyUi(tabId);
  persist();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await restored;
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    switch (msg.type) {
      case "GET_STATE": {
        const s = tabId != null ? getSession(tabId) : { recording: false };
        sendResponse({ recording: s.recording });
        break;
      }
      case "ENTRY": {
        if (tabId == null) break;
        const s = getSession(tabId);
        s.entries.push(msg.entry);
        if (s.entries.length > MAX_ENTRIES_PER_TAB) s.entries.splice(0, s.entries.length - MAX_ENTRIES_PER_TAB);
        await badge(tabId);
        notifyUi(tabId);
        persist();
        break;
      }
      case "GET_SESSION": {
        const s = tabId != null ? getSession(tabId) : { recording: false, entries: [] };
        sendResponse({ recording: s.recording, entries: s.entries, startedAt: s.startedAt });
        break;
      }
      case "SET_RECORDING": {
        if (tabId != null) await setRecording(tabId, !!msg.recording);
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_SESSION": {
        if (tabId != null) {
          const s = getSession(tabId);
          const data = await chrome.storage.local.get(SAVED_KEY);
          const saved = data[SAVED_KEY] || [];
          saved.unshift({
            id: "s" + Date.now().toString(36),
            name: msg.name || "Untitled session",
            savedAt: Date.now(),
            entries: s.entries,
          });
          await chrome.storage.local.set({ [SAVED_KEY]: saved.slice(0, 25) });
        }
        sendResponse({ ok: true });
        break;
      }
      case "LIST_SAVED": {
        const data = await chrome.storage.local.get(SAVED_KEY);
        const saved = data[SAVED_KEY] || [];
        sendResponse({ saved: saved.map(({ id, name, savedAt, entries }) => ({ id, name, savedAt, count: entries.length })) });
        break;
      }
      case "LOAD_SAVED": {
        if (tabId != null) {
          const data = await chrome.storage.local.get(SAVED_KEY);
          const found = (data[SAVED_KEY] || []).find((x) => x.id === msg.savedId);
          if (found) {
            const s = getSession(tabId);
            s.entries = found.entries || [];
            s.recording = false;
            await badge(tabId);
            notifyUi(tabId);
            persist();
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "DELETE_SAVED": {
        const data = await chrome.storage.local.get(SAVED_KEY);
        const saved = (data[SAVED_KEY] || []).filter((x) => x.id !== msg.savedId);
        await chrome.storage.local.set({ [SAVED_KEY]: saved });
        sendResponse({ ok: true });
        break;
      }
      case "CLEAR_SESSION": {
        if (tabId != null) {
          const s = getSession(tabId);
          s.entries = [];
          await badge(tabId);
          notifyUi(tabId);
          persist();
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
  })();
  return true; // async response
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  sessions.delete(tabId);
  persist();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") badge(tabId);
});
