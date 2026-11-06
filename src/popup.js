import { groupEndpoints, sessionStats, buildOpenApi, buildTsClient, buildPyClient, buildHar, templateUrl, tagNoise, sessionAuthOf } from "./core.js";
import { h, download, getActiveTabId, getSession, prepEntries, fmtBytes } from "./ui.js";

const app = document.getElementById("app");
let tabId = null;
let renderQueued = false;

async function render() {
  const session = await getSession(tabId);
  const entries = session.entries || [];
  window.__lastEntries = entries;
  const stats = sessionStats(entries);
  const endpoints = tagNoise(groupEndpoints(entries)).filter((ep) => !ep.noise);
  const origins = [...new Set(entries.map((e) => templateUrl(e.url).origin))];
  const mainOrigin = origins[0] || "";

  app.textContent = "";
  const recBtn = h("button",
    { class: session.recording ? "recording" : "primary", onclick: () => toggleRecording(session.recording) },
    session.recording ? "■ Stop recording" : "● Record this tab");
  app.append(
    h("div", { class: "row" }, recBtn,
      h("button", { onclick: openWorkbench }, "Open workbench"),
      h("button", { class: "danger", onclick: clearSession, disabled: entries.length ? undefined : "disabled" }, "Clear")),
    h("div", { class: "pad" },
      h("div", { class: "stats" },
        h("b", {}, String(stats.requests)), " requests · ",
        h("b", {}, String(stats.endpoints)), " endpoints · ",
        h("b", {}, String(stats.origins)), " origins · ",
        h("b", {}, String(stats.errors)), " errors"),
      mainOrigin ? h("div", { class: "origin" }, mainOrigin) : null),
  );

  if (!entries.length) {
    app.append(h("div", { class: "empty" },
      session.recording
        ? "Recording… use the site and its API calls will appear here."
        : "Nothing captured yet. Hit record, then use the site like a user — every API call it makes gets collected, grouped, and turned into a client."));
  } else {
    const list = h("div", { class: "pad" });
    for (const ep of endpoints.slice(0, 8)) {
      list.append(h("div", { class: "ep", onclick: openWorkbench },
        h("div", { class: "top" },
          h("span", { class: `method ${ep.method}` }, ep.method),
          h("span", { class: "tpl" }, ep.template)),
        h("div", { class: "meta" },
          `${ep.callCount} call${ep.callCount === 1 ? "" : "s"} · `,
          Object.entries(ep.statuses).map(([s, n]) =>
            h("span", { class: Number(s) >= 400 || s === "0" ? "status-err" : "status-ok" }, `${s}×${n} `)))));
    }
    if (endpoints.length > 8) list.append(h("div", { class: "meta" }, `…and ${endpoints.length - 8} more in the workbench`));
    app.append(list);
    app.append(h("div", { class: "pad row" },
      h("button", { onclick: () => exportOpenApi(endpoints, mainOrigin) }, "OpenAPI"),
      h("button", { onclick: () => exportTs(endpoints, mainOrigin) }, "TS client"),
      h("button", { onclick: () => exportPy(endpoints, mainOrigin) }, "Python client"),
      h("button", { onclick: () => exportHar(entries) }, "HAR"),
      h("span", { class: "stats" }, fmtBytes(entries.reduce((a, e) => a + (e.sizeBytes || 0), 0)), " of responses")));
  }
}

async function toggleRecording(current) {
  await chrome.runtime.sendMessage({ type: "SET_RECORDING", tabId, recording: !current });
  render();
}
async function clearSession() {
  await chrome.runtime.sendMessage({ type: "CLEAR_SESSION", tabId });
  render();
}
async function openWorkbench() {
  try { await chrome.sidePanel.open({ tabId }); } catch { /* side panel may need a user gesture context */ }
}

function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }
function exportOpenApi(endpoints, origin) {
  download(`openapi-${stamp()}.json`, JSON.stringify(buildOpenApi({ origin, endpoints }), null, 2));
}
function exportTs(endpoints, origin) {
  const entries = window.__lastEntries || [];
  download(`api_client.ts`, buildTsClient({ origin, endpoints, sessionAuth: sessionAuthOf(endpoints, entries) }), "text/typescript");
}
function exportPy(endpoints, origin) {
  const entries = window.__lastEntries || [];
  download(`api_client.py`, buildPyClient({ origin, endpoints, sessionAuth: sessionAuthOf(endpoints, entries) }), "text/x-python");
}
async function exportHar(entries) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const prepped = prepEntries(entries, false);
  download(`session-${stamp()}.har`, JSON.stringify(buildHar({ pageUrl: tab?.url, pageTitle: tab?.title, entries: prepped }), null, 2));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SESSION_UPDATED" && msg.tabId === tabId && !renderQueued) {
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 300);
  }
});

(async () => {
  tabId = await getActiveTabId();
  render();
})();
