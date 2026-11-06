// API Lens core — pure logic: URL templating, JSON schema inference, endpoint
// grouping, secret redaction, and code/spec generation. No chrome.* APIs here,
// so this file is unit-testable in plain Node.

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("0000000" + (h >>> 0).toString(16)).slice(-8);
}

// ---------- URL templating ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const DIGITS_RE = /^\d+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{22,}$/;

/** Classify one path segment: returns a placeholder kind or null if it's a literal. */
export function classifySegment(seg) {
  if (UUID_RE.test(seg)) return "uuid";
  if (DIGITS_RE.test(seg)) return "id";
  if (HEX_RE.test(seg)) return "hash";
  if (TOKEN_RE.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return "token";
  return null;
}

/**
 * Turn a concrete URL into a template: dynamic segments become {id}, {uuid}...
 * Returns { template, params: [{name, kind, example}] } — param names are made
 * unique in path order (id, id_2, uuid, ...).
 */
export function templateUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { template: rawUrl, params: [], origin: "", path: rawUrl };
  }
  const counts = {};
  const params = [];
  const segs = u.pathname.split("/").map((seg) => {
    if (!seg) return seg;
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { /* keep raw */ }
    const kind = classifySegment(decoded);
    if (!kind) return seg;
    counts[kind] = (counts[kind] || 0) + 1;
    const name = counts[kind] === 1 ? kind : `${kind}_${counts[kind]}`;
    params.push({ name, kind, example: decoded });
    return `{${name}}`;
  });
  return { template: segs.join("/") || "/", params, origin: u.origin, path: u.pathname };
}

export function queryParamsOf(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const out = {};
    for (const [k, v] of u.searchParams.entries()) {
      if (out[k] === undefined) out[k] = v;
      else if (Array.isArray(out[k])) out[k].push(v);
      else out[k] = [out[k], v];
    }
    return out;
  } catch {
    return {};
  }
}

// ---------- JSON schema inference ----------

export function inferSchema(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: {} };
    let items = inferSchema(value[0]);
    for (let i = 1; i < value.length; i++) items = mergeSchemas(items, inferSchema(value[i]));
    return { type: "array", items };
  }
  switch (typeof value) {
    case "string": return { type: "string" };
    case "number": return { type: Number.isInteger(value) ? "integer" : "number" };
    case "boolean": return { type: "boolean" };
    case "object": {
      const properties = {};
      for (const [k, v] of Object.entries(value)) properties[k] = inferSchema(v);
      return { type: "object", properties, _counts: mapValues(properties, () => 1), _n: 1 };
    }
    default: return {};
  }
}

function mapValues(obj, fn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v);
  return out;
}

/** Merge two inferred schemas into a schema that accepts both. Strips _counts bookkeeping via finalizeSchema(). */
export function mergeSchemas(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (stableStringify(a) === stableStringify(b)) return a;
  const ta = a.type, tb = b.type;
  if (ta === "integer" && tb === "number") return { type: "number" };
  if (ta === "number" && tb === "integer") return { type: "number" };
  if (ta === "object" && tb === "object") {
    const properties = { ...(a.properties || {}) };
    const counts = { ...(a._counts || {}) };
    for (const [k, v] of Object.entries(b.properties || {})) {
      if (properties[k]) {
        properties[k] = mergeSchemas(properties[k], v);
        counts[k] = (counts[k] || 0) + ((b._counts || {})[k] || 0);
      } else {
        properties[k] = v;
        counts[k] = (b._counts || {})[k] || 0;
      }
    }
    return { type: "object", properties, _counts: counts, _n: (a._n || 1) + (b._n || 1) };
  }
  if (ta === "array" && tb === "array") {
    return { type: "array", items: mergeSchemas(a.items || {}, b.items || {}) };
  }
  // Mixed types -> anyOf (deduped by type+structure)
  const options = [];
  const push = (s) => {
    if (s && s.type === undefined && s.anyOf) options.push(...s.anyOf);
    else if (s) options.push(s);
  };
  push(a); push(b);
  const seen = new Set();
  const deduped = options.filter((s) => {
    const k = stableStringify(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (deduped.length === 1) return deduped[0];
  return { anyOf: deduped };
}

/** Remove inference bookkeeping and add `required` (props seen in every sample). */
export function finalizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema || {};
  if (schema.anyOf) return { anyOf: schema.anyOf.map(finalizeSchema) };
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.type === "object") {
    out.properties = {};
    const counts = schema._counts || {};
    const n = schema._n || 1;
    const required = [];
    for (const [k, v] of Object.entries(schema.properties || {})) {
      out.properties[k] = finalizeSchema(v);
      if ((counts[k] || 0) >= n) required.push(k);
    }
    if (required.length) out.required = required.sort();
  }
  if (schema.type === "array") out.items = finalizeSchema(schema.items || {});
  return out;
}

export function inferJsonSchema(values) {
  const list = (values || []).filter((v) => v !== undefined);
  if (!list.length) return null;
  let s = inferSchema(list[0]);
  for (let i = 1; i < list.length; i++) s = mergeSchemas(s, inferSchema(list[i]));
  return finalizeSchema(s);
}

// ---------- Redaction ----------

export const SENSITIVE_HEADERS = [
  "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
  "x-session-id", "proxy-authorization", "x-csrf-token", "x-xsrf-token",
];
const SENSITIVE_BODY_KEYS = /^(password|passwd|pwd|secret|token|access_token|refresh_token|api_key|apikey|auth|ssn|credit_card|card_number|cvv)$/i;
export const REDACTED = "•••redacted•••";

export function redactHeaders(headers, keepSecrets = false) {
  if (!headers || keepSecrets) return headers || {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

export function redactBody(value, keepSecrets = false) {
  if (keepSecrets || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactBody(v, keepSecrets));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_BODY_KEYS.test(k) ? REDACTED : redactBody(v, keepSecrets);
  }
  return out;
}

export function detectAuth(headers) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  if (h["authorization"]) {
    if (String(h["authorization"]).toLowerCase().startsWith("bearer")) return { type: "bearer", header: "Authorization" };
    if (String(h["authorization"]).toLowerCase().startsWith("basic")) return { type: "basic", header: "Authorization" };
    return { type: "header", header: "Authorization" };
  }
  for (const name of ["x-api-key", "x-auth-token"]) {
    if (h[name]) return { type: "apiKey", header: name };
  }
  if (h["cookie"]) return { type: "cookie", header: "Cookie" };
  return null;
}

// ---------- Endpoint grouping ----------

/**
 * A captured entry: { id, ts, pageUrl, method, url, requestHeaders, requestBody,
 * status, responseHeaders, responseBody, durationMs, sizeBytes, transport }
 * requestBody/responseBody are parsed JSON values when JSON, raw strings otherwise, or null.
 */
export function endpointKey(entry) {
  const { template, origin } = templateUrl(entry.url);
  return `${entry.method.toUpperCase()} ${origin}${template}`;
}

export function groupEndpoints(entries) {
  const groups = new Map();
  for (const e of entries || []) {
    const key = endpointKey(e);
    if (!groups.has(key)) {
      const { template, origin, params } = templateUrl(e.url);
      groups.set(key, {
        key,
        method: e.method.toUpperCase(),
        origin,
        template,
        pathParams: params,
        calls: [],
        statuses: {},
        queryParams: new Map(),
        auth: null,
      });
    }
    const g = groups.get(key);
    g.calls.push(e);
    g.statuses[e.status] = (g.statuses[e.status] || 0) + 1;
    if (!g.auth) g.auth = detectAuth(e.requestHeaders);
    for (const [k, v] of Object.entries(queryParamsOf(e.url))) {
      if (!g.queryParams.has(k)) g.queryParams.set(k, { values: [], count: 0 });
      const rec = g.queryParams.get(k);
      rec.values.push(v);
      rec.count++;
    }
  }
  const result = [];
  for (const g of groups.values()) {
    const n = g.calls.length;
    const query = {};
    for (const [k, rec] of g.queryParams.entries()) {
      query[k] = {
        schema: inferJsonSchema(rec.values.flatMap((v) => (Array.isArray(v) ? v : [v]))) || { type: "string" },
        required: rec.count >= n,
        examples: [...new Set(rec.values.flatMap((v) => (Array.isArray(v) ? v : [v])))].slice(0, 3),
      };
    }
    result.push({
      key: g.key,
      method: g.method,
      origin: g.origin,
      template: g.template,
      pathParams: g.pathParams,
      callCount: n,
      statuses: g.statuses,
      auth: g.auth,
      query,
      requestSchema: inferJsonSchema(g.calls.map((c) => c.requestBody).filter((v) => v !== null && v !== undefined)),
      responseSchema: inferJsonSchema(g.calls.map((c) => c.responseBody).filter((v) => v !== null && v !== undefined && typeof v === "object")),
      examples: g.calls.slice(0, 3).map((c) => c.id),
      firstSeen: Math.min(...g.calls.map((c) => c.ts)),
      lastSeen: Math.max(...g.calls.map((c) => c.ts)),
    });
  }
  return result.sort((a, b) => b.callCount - a.callCount || a.key.localeCompare(b.key));
}

// ---------- Generators ----------

function fnNameFor(method, template) {
  const parts = template.split("/").filter(Boolean).map((seg) => {
    if (seg.startsWith("{")) return "By" + capitalize(seg.slice(1, -1).replace(/[^A-Za-z0-9]/g, " "));
    return capitalize(seg.replace(/[^A-Za-z0-9]/g, " "));
  });
  const base = parts.join("").replace(/\s+/g, "") || "Root";
  return method.toLowerCase() + base;
}

/** Function name for an endpoint, honoring an AI-enhance override when present. */
export function epFnName(ep) {
  return ep.fnName || fnNameFor(ep.method, ep.template);
}

// ---------- Noise classification ----------
// The LLM in a HAR-driven tool ignores telemetry by judgment; a deterministic
// tool needs patterns. These mark analytics / tracking / static noise so the
// workbench can collapse it (never delete — the user can always unhide).

const NOISE_HOST_PATTERNS = [
  "google-analytics.com", "googletagmanager.com", "analytics.", "segment.io",
  "segment.com", "mixpanel.com", "amplitude.com", "hotjar.com", "fullstory.com",
  "sentry.io", "ingest.", "telemetry.", "metrics.", "doubleclick.net",
  "facebook.net", "connect.facebook", "clarity.ms", "posthog", "bugsnag.com",
  "datadoghq.com", "nr-data.net", "newrelic.com", "intercom.io", "crisp.chat",
  "zdassets.com", "cloudflareinsights.com", "rum.", "beacon.",
];
const NOISE_PATH_PATTERNS = [
  "/track", "/collect", "/beacon", "/ping", "/heartbeat", "/telemetry",
  "/analytics", "/events/batch", "/v1/events", "/rum", "/log", "/logging",
  "/pixel", "/impression", "/pageview", "/health", "/healthz", "/favicon",
];
const STATIC_EXT_RE = /\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|webm|wasm)(\?|$)/i;

/** Classify an endpoint's origin+template+transport as likely noise. Returns a reason or null. */
export function noiseReason(ep) {
  const origin = ep.origin || "";
  const host = origin.replace(/^https?:\/\//, "");
  for (const p of NOISE_HOST_PATTERNS) {
    if (host.includes(p)) return `telemetry host (${p})`;
  }
  const t = (ep.template || "").toLowerCase();
  if (STATIC_EXT_RE.test(t)) return "static asset";
  for (const p of NOISE_PATH_PATTERNS) {
    if (t.includes(p)) return `telemetry path (${p})`;
  }
  return null;
}

export function tagNoise(endpoints) {
  return (endpoints || []).map((ep) => ({ ...ep, noise: noiseReason(ep) }));
}
function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function buildOpenApi({ origin, title, endpoints, generatedAt }) {
  const paths = {};
  for (const ep of endpoints || []) {
    const pathItem = paths[ep.template] || (paths[ep.template] = {});
    const op = {
      summary: ep.description || `Observed ${ep.method} ${ep.template} (${ep.callCount} call${ep.callCount === 1 ? "" : "s"})`,
      operationId: fnNameFor(ep.method, ep.template),
      parameters: [
        ...ep.pathParams.map((p) => ({ name: p.name, in: "path", required: true, schema: { type: "string" }, example: p.example })),
        ...Object.entries(ep.query).map(([name, q]) => ({ name, in: "query", required: q.required, schema: q.schema, example: q.examples[0] })),
      ],
      responses: {},
    };
    if (ep.requestSchema) {
      op.requestBody = { content: { "application/json": { schema: ep.requestSchema } } };
    }
    const statuses = Object.keys(ep.statuses);
    for (const status of statuses) {
      op.responses[status] = {
        description: `Observed status ${status}`,
        ...(ep.responseSchema ? { content: { "application/json": { schema: ep.responseSchema } } } : {}),
      };
    }
    if (ep.auth) op.security = [{ observedAuth: [] }];
    pathItem[ep.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: title || `API observed at ${origin}`,
      version: "0.1.0",
      description: `Reverse-engineered by API Lens from observed browser traffic. Generated ${generatedAt || new Date().toISOString()}. Schemas are inferred from samples and may be incomplete.`,
    },
    servers: [{ url: origin }],
    paths,
    components: { securitySchemes: { observedAuth: { type: "http", scheme: "bearer" } } },
  };
}

function tsType(schema, indent = "") {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.anyOf) return schema.anyOf.map((s) => tsType(s, indent)).join(" | ");
  switch (schema.type) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": return `Array<${tsType(schema.items, indent)}>`;
    case "object": {
      const props = Object.entries(schema.properties || {});
      if (!props.length) return "Record<string, unknown>";
      const req = new Set(schema.required || []);
      const lines = props.map(([k, v]) => `${indent}  ${JSON.stringify(k)}${req.has(k) ? "" : "?"}: ${tsType(v, indent + "  ")};`);
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default: return "unknown";
  }
}

function authNoteLines(sessionAuth, commentPrefix) {
  if (!sessionAuth) return [];
  const lines = [];
  lines.push(`${commentPrefix} Auth observed on this API: ${sessionAuth.type}${sessionAuth.header ? ` via the ${sessionAuth.header} header` : ""}.`);
  if (sessionAuth.value) {
    lines.push(`${commentPrefix} WARNING: the value below is a live captured credential (you enabled "include secrets").`);
    lines.push(`${commentPrefix} Treat this file like a password — do not commit or share it.`);
  } else {
    lines.push(`${commentPrefix} Credential values are NOT embedded by default — fill in your own below.`);
  }
  return lines;
}

export function buildTsClient({ origin, endpoints, sessionAuth }) {
  const out = [];
  out.push(`// Generated by API Lens from observed browser traffic at ${origin}.`);
  out.push(`// Schemas are inferred from samples — verify before relying on them.`);
  out.push(...authNoteLines(sessionAuth, "//"));
  out.push("");
  out.push(`const BASE_URL = ${JSON.stringify(origin)};`);
  if (sessionAuth) {
    const val = sessionAuth.value ? JSON.stringify(sessionAuth.value) : `"<your-${sessionAuth.type}-credential>"`;
    out.push(`const AUTH_HEADERS: Record<string, string> = { ${JSON.stringify(sessionAuth.header || "Authorization")}: ${val} };`);
  } else {
    out.push(`const AUTH_HEADERS: Record<string, string> = {};`);
  }
  out.push("");
  for (const ep of endpoints || []) {
    const name = epFnName(ep);
    const Type = capitalize(name);
    if (ep.description) out.push(`/** ${ep.description} */`);
    if (ep.requestSchema) out.push(`export type ${Type}Request = ${tsType(ep.requestSchema)};`, "");
    if (ep.responseSchema) out.push(`export type ${Type}Response = ${tsType(ep.responseSchema)};`, "");
    const pathArgs = ep.pathParams.map((p) => `${p.name}: string`).join(", ");
    const queryNames = Object.keys(ep.query);
    const args = [];
    if (pathArgs) args.push(pathArgs);
    if (ep.requestSchema) args.push(`body: ${Type}Request`);
    if (queryNames.length) args.push(`query: { ${queryNames.map((q) => `${JSON.stringify(q)}?: string`).join("; ")} } = {}`);
    const urlExpr = "`" + ep.template.replace(/\{(\w+)\}/g, "${$1}") + "`";
    out.push(`export async function ${name}(${args.join(", ")}): Promise<${ep.responseSchema ? `${Type}Response` : "unknown"}> {`);
    if (queryNames.length) {
      out.push(`  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined) as [string, string][]);`);
      out.push(`  const res = await fetch(\`\${BASE_URL}${urlExpr}?\${qs}\`, {`);
    } else {
      out.push(`  const res = await fetch(\`\${BASE_URL}${urlExpr}\`, {`);
    }
    out.push(`    method: ${JSON.stringify(ep.method)},`);
    if (ep.requestSchema) out.push(`    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },`, `    body: JSON.stringify(body),`);
    else out.push(`    headers: { ...AUTH_HEADERS },`);
    out.push(`  });`);
    out.push(`  if (!res.ok) throw new Error(\`${ep.method} ${ep.template} failed: \${res.status}\`);`);
    out.push(`  return res.json();`);
    out.push(`}`, "");
  }
  const gets = (endpoints || []).filter((e) => e.method === "GET").slice(0, 3);
  if (gets.length) {
    out.push(`// ---- Example usage ----`);
    for (const ep of gets) {
      const sampleArgs = ep.pathParams.map((p) => JSON.stringify(p.example || "1")).join(", ");
      out.push(`// const result = await ${epFnName(ep)}(${sampleArgs});`);
    }
  }
  return out.join("\n");
}

export function buildJsClient({ origin, endpoints, sessionAuth }) {
  const out = [];
  out.push(`// Generated by API Lens from observed browser traffic at ${origin}.`);
  out.push(`// Response shapes are described in each function's JSDoc — inferred from samples.`);
  out.push(...authNoteLines(sessionAuth, "//"));
  out.push("");
  out.push(`const BASE_URL = ${JSON.stringify(origin)};`);
  if (sessionAuth) {
    const val = sessionAuth.value ? JSON.stringify(sessionAuth.value) : `"<your-${sessionAuth.type}-credential>"`;
    out.push(`const AUTH_HEADERS = { ${JSON.stringify(sessionAuth.header || "Authorization")}: ${val} };`);
  } else {
    out.push(`const AUTH_HEADERS = {};`);
  }
  out.push("");
  for (const ep of endpoints || []) {
    const name = epFnName(ep);
    const pathArgs = ep.pathParams.map((p) => p.name).join(", ");
    const queryNames = Object.keys(ep.query);
    const args = [];
    if (pathArgs) args.push(pathArgs);
    if (ep.requestSchema) args.push("body");
    if (queryNames.length) args.push("query = {}");
    const urlExpr = "`" + ep.template.replace(/\{(\w+)\}/g, "${$1}") + "`";
    if (ep.description) out.push(`/** ${ep.description} */`);
    else out.push(`/** ${ep.method} ${ep.template} — observed ${ep.callCount}x. */`);
    out.push(`export async function ${name}(${args.join(", ")}) {`);
    if (queryNames.length) {
      out.push(`  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined));`);
      out.push(`  const res = await fetch(\`\${BASE_URL}${urlExpr}?\${qs}\`, {`);
    } else {
      out.push(`  const res = await fetch(\`\${BASE_URL}${urlExpr}\`, {`);
    }
    out.push(`    method: ${JSON.stringify(ep.method)},`);
    if (ep.requestSchema) out.push(`    headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },`, `    body: JSON.stringify(body),`);
    else out.push(`    headers: { ...AUTH_HEADERS },`);
    out.push(`  });`);
    out.push(`  if (!res.ok) throw new Error(\`${ep.method} ${ep.template} failed: \${res.status}\`);`);
    out.push(`  return res.json();`);
    out.push(`}`, "");
  }
  return out.join("\n");
}

function goType(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (schema.anyOf) return "any";
  switch (schema.type) {
    case "string": return "string";
    case "integer": return "int64";
    case "number": return "float64";
    case "boolean": return "bool";
    case "null": return "any";
    case "array": return "[]" + goType(schema.items);
    case "object": return "map[string]any";
    default: return "any";
  }
}

function goStruct(name, schema) {
  const lines = [`type ${name} struct {`];
  const req = new Set(schema.required || []);
  for (const [k, v] of Object.entries(schema.properties || {})) {
    const field = capitalize(k.replace(/[^A-Za-z0-9]/g, " "));
    const omitempty = req.has(k) ? "" : ",omitempty";
    lines.push(`\t${field.replace(/\s+/g, "")} ${goType(v)} \`json:"${k}${omitempty}"\``);
  }
  lines.push("}");
  return lines.join("\n");
}

export function buildGoClient({ origin, endpoints, sessionAuth }) {
  const out = [];
  out.push(`// Generated by API Lens from observed browser traffic at ${origin}.`);
  out.push(`// Schemas are inferred from samples — verify before relying on them.`);
  out.push(...authNoteLines(sessionAuth, "//"));
  out.push("");
  out.push("package apiclient");
  out.push("");
  out.push("import (");
  out.push(`\t"bytes"`);
  out.push(`\t"encoding/json"`);
  out.push(`\t"fmt"`);
  out.push(`\t"net/http"`);
  out.push(`\t"net/url"`);
  out.push(")");
  out.push("");
  out.push(`const BaseURL = ${JSON.stringify(origin)}`);
  if (sessionAuth) {
    const val = sessionAuth.value ? JSON.stringify(sessionAuth.value) : `"<your-${sessionAuth.type}-credential>"`;
    out.push(`var AuthHeaders = map[string]string{${JSON.stringify(sessionAuth.header || "Authorization")}: ${val}}`);
  } else {
    out.push(`var AuthHeaders = map[string]string{}`);
  }
  out.push("");
  for (const ep of endpoints || []) {
    const name = capitalize(epFnName(ep));
    if (ep.requestSchema && ep.requestSchema.type === "object") out.push(goStruct(name + "Request", ep.requestSchema), "");
    if (ep.responseSchema && ep.responseSchema.type === "object") out.push(goStruct(name + "Response", ep.responseSchema), "");
    const args = ep.pathParams.map((p) => `${p.name} string`);
    if (ep.requestSchema) args.push(`body *${name}Request`);
    const queryNames = Object.keys(ep.query);
    if (queryNames.length) args.push("query map[string]string");
    const retType = ep.responseSchema && ep.responseSchema.type === "object" ? `*${name}Response` : "json.RawMessage";
    const pathExpr = ep.template.replace(/\{(\w+)\}/g, "%s");
    const sprintfArgs = ep.pathParams.map((p) => p.name).join(", ");
    if (ep.description) out.push(`// ${name} — ${ep.description}`);
    else out.push(`// ${name} — ${ep.method} ${ep.template} (observed ${ep.callCount}x).`);
    out.push(`func ${name}(${args.join(", ")}) (${retType}, error) {`);
    if (ep.pathParams.length) out.push(`\tu := BaseURL + fmt.Sprintf(${JSON.stringify(pathExpr)}${sprintfArgs ? ", " + sprintfArgs : ""})`);
    else out.push(`\tu := BaseURL + ${JSON.stringify(ep.template)}`);
    if (queryNames.length) {
      out.push(`\tq := url.Values{}`);
      out.push(`\tfor k, v := range query { q.Set(k, v) }`);
      out.push(`\tif len(q) > 0 { u += "?" + q.Encode() }`);
    }
    if (ep.requestSchema) {
      out.push(`\tpayload, err := json.Marshal(body)`);
      out.push(`\tif err != nil { return nil, err }`);
      out.push(`\treq, err := http.NewRequest(${JSON.stringify(ep.method)}, u, bytes.NewReader(payload))`);
    } else {
      out.push(`\treq, err := http.NewRequest(${JSON.stringify(ep.method)}, u, nil)`);
    }
    out.push(`\tif err != nil { return nil, err }`);
    if (ep.requestSchema) out.push(`\treq.Header.Set("Content-Type", "application/json")`);
    out.push(`\tfor k, v := range AuthHeaders { req.Header.Set(k, v) }`);
    out.push(`\tresp, err := http.DefaultClient.Do(req)`);
    out.push(`\tif err != nil { return nil, err }`);
    out.push(`\tdefer resp.Body.Close()`);
    out.push(`\tif resp.StatusCode >= 300 { return nil, fmt.Errorf("${ep.method} ${ep.template} failed: %d", resp.StatusCode) }`);
    if (retType === "json.RawMessage") {
      out.push(`\tvar raw json.RawMessage`);
      out.push(`\tif err := json.NewDecoder(resp.Body).Decode(&raw); err != nil { return nil, err }`);
      out.push(`\treturn raw, nil`);
    } else {
      out.push(`\tvar out ${retType.slice(1)}`);
      out.push(`\tif err := json.NewDecoder(resp.Body).Decode(&out); err != nil { return nil, err }`);
      out.push(`\treturn &out, nil`);
    }
    out.push(`}`, "");
  }
  return out.join("\n");
}

function pyType(schema) {
  if (!schema || typeof schema !== "object") return "Any";
  if (schema.anyOf) return "Any";
  switch (schema.type) {
    case "string": return "str";
    case "integer": return "int";
    case "number": return "float";
    case "boolean": return "bool";
    case "null": return "None";
    case "array": return `list[${pyType(schema.items)}]`;
    case "object": return "dict[str, Any]";
    default: return "Any";
  }
}

export function buildPyClient({ origin, endpoints, sessionAuth }) {
  const out = [];
  out.push(`"""Generated by API Lens from observed browser traffic at ${origin}.`);
  out.push(`Schemas are inferred from samples — verify before relying on them.`);
  for (const line of authNoteLines(sessionAuth, "")) out.push(line);
  out.push(`"""`);
  out.push("");
  out.push("from typing import Any, Optional");
  out.push("import httpx");
  out.push("");
  out.push(`BASE_URL = ${JSON.stringify(origin)}`);
  if (sessionAuth) {
    const val = sessionAuth.value ? JSON.stringify(sessionAuth.value) : `"<your-${sessionAuth.type}-credential>"`;
    out.push(`AUTH_HEADERS = {${JSON.stringify(sessionAuth.header || "Authorization")}: ${val}}`);
  } else {
    out.push("AUTH_HEADERS = {}");
  }
  out.push("");
  out.push("");
  out.push("class ApiClient:");
  out.push(`    def __init__(self, base_url: str = BASE_URL, headers: Optional[dict] = None):`);
  out.push("        merged = dict(AUTH_HEADERS)");
  out.push("        merged.update(headers or {})");
  out.push("        self._client = httpx.Client(base_url=base_url, headers=merged)");
  out.push("");
  for (const ep of endpoints || []) {
    const name = epFnName(ep);
    const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const args = ["self", ...ep.pathParams.map((p) => `${p.name}: str`)];
    if (ep.requestSchema) args.push("body: dict[str, Any]");
    const queryNames = Object.keys(ep.query);
    if (queryNames.length) args.push("**query: Any");
    out.push(`    def ${snake}(${args.join(", ")}) -> Any:`);
    const doc = (ep.description || `${ep.method} ${ep.template} — observed ${ep.callCount}x.`).replace(/"/g, "'");
    out.push(`        """${doc}"""`);
    const pathExpr = ep.template.replace(/\{(\w+)\}/g, "{$1}");
    const callArgs = [`f"${pathExpr}"`];
    if (ep.requestSchema) callArgs.push("json=body");
    if (queryNames.length) callArgs.push("params={k: v for k, v in query.items() if v is not None}");
    out.push(`        resp = self._client.request(${JSON.stringify(ep.method)}, ${callArgs.join(", ")})`);
    out.push("        resp.raise_for_status()");
    out.push("        return resp.json()");
    out.push("");
  }
  const gets = (endpoints || []).filter((e) => e.method === "GET" && !e.requestSchema).slice(0, 2);
  if (gets.length) {
    out.push("");
    out.push('if __name__ == "__main__":');
    out.push("    client = ApiClient()");
    for (const ep of gets) {
      const snake = epFnName(ep).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const sampleArgs = ep.pathParams.map((p) => JSON.stringify(p.example || "1")).join(", ");
      out.push(`    print(client.${snake}(${sampleArgs}))`);
    }
  }
  return out.join("\n");
}

/** Most common auth pattern across endpoints, for client-level auth blocks. */
export function sessionAuthOf(endpoints, entries, keepSecrets = false) {
  const counts = new Map();
  for (const ep of endpoints || []) {
    if (ep.auth) {
      const k = ep.auth.type + "|" + (ep.auth.header || "");
      counts.set(k, (counts.get(k) || 0) + ep.callCount);
    }
  }
  if (!counts.size) return null;
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const [type, header] = best.split("|");
  const auth = { type, header: header || "Authorization" };
  if (keepSecrets && entries) {
    for (const e of entries) {
      for (const [k, v] of Object.entries(e.requestHeaders || {})) {
        if (k.toLowerCase() === auth.header.toLowerCase()) { auth.value = v; return auth; }
      }
    }
  }
  return auth;
}

export function buildHar({ pageUrl, pageTitle, entries }) {
  return {
    log: {
      version: "1.2",
      creator: { name: "API Lens", version: "1.0.0" },
      pages: [{ startedDateTime: new Date((entries?.[0]?.ts) || Date.now()).toISOString(), id: "page_1", title: pageTitle || pageUrl || "", pageTimings: {} }],
      entries: (entries || []).map((e) => ({
        pageref: "page_1",
        startedDateTime: new Date(e.ts).toISOString(),
        time: e.durationMs || 0,
        request: {
          method: e.method,
          url: e.url,
          httpVersion: "HTTP/2",
          headers: Object.entries(e.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: Object.entries(queryParamsOf(e.url)).map(([name, value]) => ({ name, value: String(value) })),
          ...(e.requestBodyRaw ? { postData: { mimeType: "application/json", text: e.requestBodyRaw } } : {}),
          headersSize: -1,
          bodySize: e.requestBodyRaw ? e.requestBodyRaw.length : 0,
        },
        response: {
          status: e.status,
          statusText: "",
          httpVersion: "HTTP/2",
          headers: Object.entries(e.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          content: {
            size: e.sizeBytes || 0,
            mimeType: (e.responseHeaders && (e.responseHeaders["content-type"] || e.responseHeaders["Content-Type"])) || "",
            text: e.responseBodyRaw || "",
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: e.sizeBytes || 0,
        },
        cache: {},
        timings: { send: 0, wait: e.durationMs || 0, receive: 0 },
        _transport: e.transport,
      })),
    },
  };
}

export function buildCurl(entry, keepSecrets = false) {
  const headers = redactHeaders(entry.requestHeaders || {}, keepSecrets);
  const parts = [`curl -X ${entry.method.toUpperCase()} ${JSON.stringify(entry.url)}`];
  for (const [k, v] of Object.entries(headers)) parts.push(`  -H ${JSON.stringify(`${k}: ${v}`)}`);
  if (entry.requestBodyRaw) parts.push(`  --data-raw ${JSON.stringify(entry.requestBodyRaw)}`);
  return parts.join(" \\\n");
}

export function sessionStats(entries) {
  const eps = groupEndpoints(entries || []);
  const origins = new Set((entries || []).map((e) => templateUrl(e.url).origin));
  return {
    requests: (entries || []).length,
    endpoints: eps.length,
    origins: origins.size,
    errors: (entries || []).filter((e) => e.status >= 400).length,
  };
}
