// Shared UI helpers for popup + side panel.
import { redactHeaders, redactBody } from "./core.js";

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = h("div", { class: "toast" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1400);
}

export async function copyText(text, label = "Copied") {
  await navigator.clipboard.writeText(text);
  toast(label);
}

export function download(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/** Render a (finalized) JSON schema as a collapsible tree. */
export function renderSchema(schema) {
  const wrap = h("div");
  if (!schema) {
    wrap.append(h("div", { class: "schema-node" }, "— none observed —"));
    return wrap;
  }
  wrap.append(schemaNode(schema, null, true));
  return wrap;
}

function schemaNode(schema, key, required) {
  const node = h("div", { class: "schema-node" });
  if (!schema || typeof schema !== "object") {
    node.append(h("span", { class: "t" }, "unknown"));
    return node;
  }
  const head = h("span");
  if (key !== null && key !== undefined) {
    head.append(h("span", { class: "k" }, key), " : ");
  }
  if (schema.anyOf) {
    head.append(h("span", { class: "t" }, schema.anyOf.map((s) => s.type || "any").join(" | ")));
    node.append(head);
    return node;
  }
  head.append(h("span", { class: "t" }, schema.type || "any"));
  if (required) head.append(" ", h("span", { class: "req" }, "required"));
  node.append(head);
  if (schema.type === "object" && schema.properties) {
    const req = new Set(schema.required || []);
    for (const [k, v] of Object.entries(schema.properties)) {
      node.append(schemaNode(v, k, req.has(k)));
    }
  } else if (schema.type === "array" && schema.items) {
    node.append(schemaNode(schema.items, "[]", false));
  }
  return node;
}

export function jsonPre(value) {
  if (value === null || value === undefined) return h("pre", { class: "json" }, "—");
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return h("pre", { class: "json" }, text.length > 20000 ? text.slice(0, 20000) + "\n… (truncated)" : text);
}

/** Prepare entries for export: secrets redacted unless keepSecrets is on. */
export function prepEntries(entries, keepSecrets) {
  if (keepSecrets) return entries;
  return entries.map((e) => {
    const out = {
      ...e,
      requestHeaders: redactHeaders(e.requestHeaders || {}),
      responseHeaders: redactHeaders(e.responseHeaders || {}),
      requestBody: redactBody(e.requestBody),
      responseBody: redactBody(e.responseBody),
    };
    for (const field of ["requestBodyRaw", "responseBodyRaw"]) {
      if (out[field]) {
        try {
          const parsed = JSON.parse(out[field]);
          out[field] = JSON.stringify(redactBody(parsed));
        } catch { /* non-JSON raw bodies pass through unchanged */ }
      }
    }
    return out;
  });
}

export async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

export async function getSession(tabId) {
  return chrome.runtime.sendMessage({ type: "GET_SESSION", tabId });
}
