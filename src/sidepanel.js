import {
  groupEndpoints, sessionStats, buildOpenApi, buildTsClient, buildPyClient,
  buildJsClient, buildGoClient, buildHar, buildCurl, templateUrl,
  tagNoise, sessionAuthOf, epFnName,
} from "./core.js";
import { h, download, copyText, renderSchema, jsonPre, prepEntries, getSession, fmtBytes, fmtClock } from "./ui.js";

const SETTINGS_KEY = "apilens_settings_v1";
const ENHANCE_KEY = "apilens_enhance_v1";

let tabId = null;
let session = { recording: false, entries: [] };
let selectedKey = null;
let search = "";
let keepSecrets = false;
let hideNoise = true;
let renderQueued = false;
let settings = { apiKey: "", model: "openrouter/free", goal: "" };
let enhanceByOrigin = {};
let aiStatus = "";

const controlsEl = document.getElementById("controls");
const listEl = document.getElementById("list");
const detailEl = document.getElementById("detail");
const pageInfo = document.getElementById("pageinfo");

async function load() {
  session = await getSession(tabId);
  const data = await chrome.storage.local.get([SETTINGS_KEY, ENHANCE_KEY]);
  settings = { ...settings, ...(data[SETTINGS_KEY] || {}) };
  enhanceByOrigin = data[ENHANCE_KEY] || {};
  render();
}

function mainOrigin(entries) {
  const first = (entries || [])[0];
  return first ? templateUrl(first.url).origin : "";
}

function enhanced(endpoints) {
  const map = enhanceByOrigin[mainOrigin(session.entries)] || {};
  return endpoints.map((ep) => {
    const e = map[ep.key];
    if (!e) return ep;
    return { ...ep, fnName: e.fnName || ep.fnName, description: e.description || ep.description, aiSkip: !!e.skip };
  });
}

function currentEndpoints() {
  return enhanced(tagNoise(groupEndpoints(session.entries || [])));
}

function exportEndpoints() {
  return currentEndpoints().filter((ep) => !ep.noise && !ep.aiSkip);
}

function render() {
  const entries = session.entries || [];
  const stats = sessionStats(entries);
  const all = currentEndpoints();
  const visible = all.filter((ep) =>
    (!hideNoise || !ep.noise) &&
    (!search || ep.key.toLowerCase().includes(search.toLowerCase()) || (ep.fnName || "").toLowerCase().includes(search.toLowerCase())));
  const noiseCount = all.filter((ep) => ep.noise).length;

  pageInfo.textContent = entries.length
    ? `${stats.requests} requests · ${stats.endpoints} endpoints · ${stats.errors} errors`
    : "No captures on this tab yet";

  controlsEl.textContent = "";
  const dis = entries.length ? undefined : "disabled";
  controlsEl.append(
    h("button", {
      class: session.recording ? "recording" : "primary",
      onclick: async () => {
        await chrome.runtime.sendMessage({ type: "SET_RECORDING", tabId, recording: !session.recording });
        load();
      },
    }, session.recording ? "■ Stop" : "● Record"),
    h("input", {
      type: "search", placeholder: "Filter endpoints…", value: search,
      oninput: (e) => { search = e.target.value; render(); },
    }),
    h("label", { class: "check" },
      h("input", { type: "checkbox", ...(hideNoise ? { checked: "checked" } : {}), onchange: (e) => { hideNoise = e.target.checked; render(); } }),
      ` hide telemetry${noiseCount ? ` (${noiseCount})` : ""}`),
    h("label", { class: "check" },
      h("input", { type: "checkbox", ...(keepSecrets ? { checked: "checked" } : {}), onchange: (e) => { keepSecrets = e.target.checked; } }),
      " include secrets in exports"),
    h("button", { onclick: saveSession, disabled: dis }, "💾 Save session"),
    h("button", { onclick: toggleAiPanel }, "✨ AI enhance"),
    h("button", { onclick: () => doExport("openapi"), disabled: dis }, "OpenAPI"),
    h("button", { onclick: () => doExport("ts"), disabled: dis }, "TS"),
    h("button", { onclick: () => doExport("js"), disabled: dis }, "JS"),
    h("button", { onclick: () => doExport("py"), disabled: dis }, "Python"),
    h("button", { onclick: () => doExport("go"), disabled: dis }, "Go"),
    h("button", { onclick: () => doExport("har"), disabled: dis }, "HAR"),
    h("button", { class: "danger", onclick: clearSession, disabled: dis }, "Clear"),
    h("div", { id: "aipanel", style: "width:100%" }),
    h("div", { id: "savedpanel", style: "width:100%" }),
  );
  renderSavedPanel();

  listEl.textContent = "";
  if (!entries.length) {
    listEl.append(h("div", { class: "empty" },
      session.recording
        ? "Recording — go use the site. Its API calls land here, grouped into endpoints."
        : "Press Record, then use the site. API Lens collects the calls and reverse-engineers the API."));
  }
  for (const ep of visible) {
    listEl.append(h("div", {
      class: "ep" + (ep.key === selectedKey ? " selected" : ""),
      onclick: () => { selectedKey = ep.key; render(); },
    },
      h("div", { class: "top" },
        h("span", { class: `method ${ep.method}` }, ep.method),
        h("span", { class: "tpl" }, epFnName(ep) !== defaultName(ep) ? ep.template : ep.template)),
      h("div", { class: "meta" },
        ep.fnName ? h("span", {}, `ƒ ${ep.fnName} · `) : null,
        `${ep.callCount} call${ep.callCount === 1 ? "" : "s"} · `,
        Object.entries(ep.statuses).map(([s, n]) =>
          h("span", { class: Number(s) >= 400 || s === "0" ? "status-err" : "status-ok" }, `${s}×${n} `)),
        ep.auth ? h("span", {}, ` · 🔐 ${ep.auth.type}`) : null,
        ep.noise ? h("span", {}, ` · noise: ${ep.noise}`) : null)));
  }
  if (hideNoise && noiseCount) {
    listEl.append(h("div", { class: "meta", style: "padding:4px" },
      `${noiseCount} telemetry/static endpoint${noiseCount === 1 ? "" : "s"} hidden — untick "hide telemetry" to see them. Exports always exclude noise.`));
  }

  const ep = all.find((e) => e.key === selectedKey);
  renderDetail(ep, entries);
}

function defaultName(ep) {
  return ep.key;
}

function renderDetail(ep, entries) {
  detailEl.textContent = "";
  if (!ep) {
    detailEl.append(h("div", { class: "empty" }, entries.length ? "Pick an endpoint on the left to inspect its inferred contract." : "—"));
    return;
  }
  detailEl.append(
    h("div", { class: "row" },
      h("span", { class: `method ${ep.method}` }, ep.method),
      h("span", { style: "font-family:var(--mono)" }, ep.origin + ep.template)),
    ep.fnName ? h("div", { class: "stats" }, `ƒ ${ep.fnName}${ep.description ? " — " + ep.description : ""}`) : null,
    h("div", { class: "stats" },
      `${ep.callCount} calls · first ${fmtClock(ep.firstSeen)} · last ${fmtClock(ep.lastSeen)}`,
      ep.auth ? ` · auth: ${ep.auth.type} (${ep.auth.header})` : " · no auth header observed",
      ep.noise ? ` · classified noise: ${ep.noise}` : ""),
  );

  const queryNames = Object.keys(ep.query);
  if (queryNames.length) {
    detailEl.append(h("h2", { class: "section" }, "Query parameters"));
    const table = h("table", { class: "params" },
      h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Required"), h("th", {}, "Examples")));
    for (const name of queryNames) {
      const q = ep.query[name];
      table.append(h("tr", {},
        h("td", {}, name), h("td", {}, q.schema.type || "any"),
        h("td", {}, q.required ? "yes" : "no"), h("td", {}, q.examples.join(", "))));
    }
    detailEl.append(table);
  }
  if (ep.pathParams.length) {
    detailEl.append(h("h2", { class: "section" }, "Path parameters"),
      h("div", { class: "stats" }, ep.pathParams.map((p) => `${p.name} (e.g. ${p.example})`).join(" · ")));
  }

  detailEl.append(h("h2", { class: "section" }, "Request body schema"), renderSchema(ep.requestSchema));
  detailEl.append(h("h2", { class: "section" }, "Response schema"), renderSchema(ep.responseSchema));

  detailEl.append(h("h2", { class: "section" }, `Calls (${ep.callCount})`));
  const calls = entries.filter((e) => sameEndpoint(e, ep));
  for (const c of calls.slice(-25).reverse()) {
    const body = h("div", {});
    const row = h("div", { class: "call" },
      h("span", { class: "st " + (c.status >= 400 || c.status === 0 ? "status-err" : "status-ok") }, String(c.status || "ERR")),
      ` ${fmtClock(c.ts)} · ${c.transport} · ${c.durationMs || 0}ms · ${fmtBytes(c.sizeBytes || 0)}`,
      h("br"), c.url,
      h("div", { class: "row", style: "margin-top:4px" },
        h("button", { onclick: () => copyText(buildCurl(prepEntries([c], keepSecrets)[0], keepSecrets), "curl copied") }, "Copy curl"),
        h("button", { onclick: () => { body.textContent = ""; body.append(jsonPre(c.requestBody ?? c.requestBodyRaw), jsonPre(c.responseBody ?? c.responseBodyRaw)); } }, "Bodies"),
        h("button", { onclick: () => { body.textContent = ""; body.append(jsonPre({ request: c.requestHeaders, response: c.responseHeaders })); } }, "Headers")),
      body);
    detailEl.append(row);
  }
}

function sameEndpoint(entry, ep) {
  const t = templateUrl(entry.url);
  return entry.method.toUpperCase() === ep.method && t.origin + t.template === ep.origin + ep.template;
}

// ---------- Saved sessions ----------

async function saveSession() {
  const name = prompt("Name this session:", document.title || "Session");
  if (name === null) return;
  await chrome.runtime.sendMessage({ type: "SAVE_SESSION", tabId, name });
  renderSavedPanel();
}

async function renderSavedPanel() {
  const panel = document.getElementById("savedpanel");
  if (!panel) return;
  const { saved } = await chrome.runtime.sendMessage({ type: "LIST_SAVED" });
  panel.textContent = "";
  if (!saved || !saved.length) return;
  panel.append(h("span", { class: "stats" }, "Saved: "));
  for (const s of saved) {
    panel.append(
      h("button", { onclick: async () => { await chrome.runtime.sendMessage({ type: "LOAD_SAVED", tabId, savedId: s.id }); selectedKey = null; load(); } },
        `📂 ${s.name} (${s.count})`),
      h("button", { class: "danger", onclick: async () => { await chrome.runtime.sendMessage({ type: "DELETE_SAVED", savedId: s.id }); renderSavedPanel(); } }, "✕"),
    );
  }
}

// ---------- AI enhance ----------

function toggleAiPanel() {
  const panel = document.getElementById("aipanel");
  if (!panel) return;
  if (panel.childNodes.length) { panel.textContent = ""; return; }
  const keyInput = h("input", { type: "password", placeholder: "OpenRouter API key (stored locally, optional)", value: settings.apiKey, style: "width:260px" });
  const modelInput = h("input", { type: "text", placeholder: "model", value: settings.model, style: "width:170px" });
  const goalInput = h("input", { type: "text", placeholder: "Goal (optional) — e.g. 'fetch the top stories'", value: settings.goal, style: "width:260px" });
  const status = h("span", { class: "stats" }, aiStatus);
  panel.append(h("div", { class: "row", style: "margin-top:6px" },
    keyInput, modelInput, goalInput,
    h("button", { class: "primary", onclick: async () => {
      settings = { apiKey: keyInput.value.trim(), model: modelInput.value.trim() || "openrouter/free", goal: goalInput.value.trim() };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      runEnhance(status);
    } }, "Run enhance"),
    status));
  panel.append(h("div", { class: "stats" },
    "Sends endpoint shapes (names + field types only — never credential values, never body values) to OpenRouter with your key. Names/descriptions it returns are applied to the list and all generated clients."));
}

function summarizeSchema(schema, depth = 0) {
  if (!schema || depth > 3) return "any";
  if (schema.anyOf) return schema.anyOf.map((s) => summarizeSchema(s, depth + 1)).join("|");
  if (schema.type === "object") {
    const props = Object.entries(schema.properties || {}).map(([k, v]) => `${k}:${summarizeSchema(v, depth + 1)}`);
    return `{${props.join(", ")}}`;
  }
  if (schema.type === "array") return `[${summarizeSchema(schema.items, depth + 1)}]`;
  return schema.type || "any";
}

async function runEnhance(statusEl) {
  const setStatus = (t) => { aiStatus = t; if (statusEl) statusEl.textContent = t; };
  if (!settings.apiKey) { setStatus("Add your OpenRouter key first — it's stored only in this browser."); return; }
  const eps = currentEndpoints().filter((ep) => !ep.noise);
  if (!eps.length) { setStatus("Nothing to enhance yet."); return; }
  setStatus(`Asking ${settings.model} to label ${eps.length} endpoints…`);
  const payload = eps.map((ep) => ({
    key: ep.key,
    query: Object.keys(ep.query),
    request: summarizeSchema(ep.requestSchema),
    response: summarizeSchema(ep.responseSchema),
    calls: ep.callCount,
  }));
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "API Lens",
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: "system",
            content: "You label reverse-engineered API endpoints. Reply with JSON only, no prose: {\"endpoints\":[{\"key\":\"<exact key given>\",\"fnName\":\"<camelCase verb-first name>\",\"description\":\"<one plain sentence>\",\"skip\":<true if telemetry/useless>}]}. Cover every key exactly once.",
          },
          {
            role: "user",
            content: (settings.goal ? `User goal: ${settings.goal}\n` : "") + "Endpoints:\n" + JSON.stringify(payload, null, 1),
          },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || "";
    text = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    const map = {};
    for (const e of parsed.endpoints || []) {
      if (e && e.key) map[e.key] = { fnName: e.fnName, description: e.description, skip: !!e.skip };
    }
    const origin = mainOrigin(session.entries);
    enhanceByOrigin[origin] = map;
    await chrome.storage.local.set({ [ENHANCE_KEY]: enhanceByOrigin });
    setStatus(`Enhanced ${Object.keys(map).length} endpoints. Exports now use these names.`);
    render();
  } catch (err) {
    setStatus(`Enhance failed: ${err.message}. Your deterministic clients still work.`);
  }
}

// ---------- Exports ----------

function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"); }

async function doExport(kind) {
  const entries = session.entries || [];
  const eps = exportEndpoints();
  const origin = mainOrigin(entries);
  const auth = sessionAuthOf(eps, entries, keepSecrets);
  switch (kind) {
    case "openapi":
      download(`openapi-${stamp()}.json`, JSON.stringify(buildOpenApi({ origin, endpoints: eps }), null, 2));
      break;
    case "ts": download("api_client.ts", buildTsClient({ origin, endpoints: eps, sessionAuth: auth }), "text/typescript"); break;
    case "js": download("api_client.js", buildJsClient({ origin, endpoints: eps, sessionAuth: auth }), "text/javascript"); break;
    case "py": download("api_client.py", buildPyClient({ origin, endpoints: eps, sessionAuth: auth }), "text/x-python"); break;
    case "go": download("api_client.go", buildGoClient({ origin, endpoints: eps, sessionAuth: auth }), "text/plain"); break;
    case "har": {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      download(`session-${stamp()}.har`,
        JSON.stringify(buildHar({ pageUrl: tab?.url, pageTitle: tab?.title, entries: prepEntries(entries, keepSecrets) }), null, 2));
      break;
    }
  }
}

async function clearSession() {
  await chrome.runtime.sendMessage({ type: "CLEAR_SESSION", tabId });
  selectedKey = null;
  load();
}

async function followActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id !== tabId) {
    tabId = tab.id;
    selectedKey = null;
    load();
  }
}

chrome.tabs.onActivated.addListener(followActiveTab);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SESSION_UPDATED" && msg.tabId === tabId && !renderQueued) {
    renderQueued = true;
    setTimeout(() => { renderQueued = false; load(); }, 300);
  }
});

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  load();
})();
