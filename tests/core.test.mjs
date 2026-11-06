import { test } from "node:test";
import assert from "node:assert/strict";
import {
  templateUrl, classifySegment, inferJsonSchema, mergeSchemas,
  redactHeaders, redactBody, detectAuth, groupEndpoints,
  buildOpenApi, buildTsClient, buildPyClient, buildJsClient, buildGoClient,
  buildHar, buildCurl, sessionStats, tagNoise, noiseReason, sessionAuthOf, epFnName,
} from "../src/core.js";

test("classifySegment spots dynamic segments", () => {
  assert.equal(classifySegment("42"), "id");
  assert.equal(classifySegment("550e8400-e29b-41d4-a716-446655440000"), "uuid");
  assert.equal(classifySegment("deadbeefcafe1234"), "hash");
  assert.equal(classifySegment("users"), null);
  assert.equal(classifySegment("v2"), null);
});

test("templateUrl replaces ids and keeps origin", () => {
  const t = templateUrl("https://api.example.com/users/42/posts/7?x=1");
  assert.equal(t.template, "/users/{id}/posts/{id_2}");
  assert.equal(t.origin, "https://api.example.com");
  assert.equal(t.params.length, 2);
  assert.equal(t.params[0].example, "42");
});

test("schema inference merges objects and computes required", () => {
  const s = inferJsonSchema([
    { id: 1, name: "a", nick: "x" },
    { id: 2, name: "b" },
  ]);
  assert.equal(s.type, "object");
  assert.equal(s.properties.id.type, "integer");
  assert.deepEqual(s.required.sort(), ["id", "name"]);
});

test("schema inference promotes integer to number and handles arrays/nulls", () => {
  const s = inferJsonSchema([{ v: 1 }, { v: 1.5 }]);
  assert.equal(s.properties.v.type, "number");
  const arr = inferJsonSchema([[1, 2], [3]]);
  assert.equal(arr.type, "array");
  assert.equal(arr.items.type, "integer");
  const mixed = mergeSchemas({ type: "string" }, { type: "null" });
  assert.ok(mixed.anyOf);
});

test("redaction hides secrets by default, keeps them when asked", () => {
  const h = redactHeaders({ Authorization: "Bearer abc", "Content-Type": "application/json" });
  assert.equal(h.Authorization, "•••redacted•••");
  assert.equal(h["Content-Type"], "application/json");
  const kept = redactHeaders({ Authorization: "Bearer abc" }, true);
  assert.equal(kept.Authorization, "Bearer abc");
  const b = redactBody({ user: "k", password: "hunter2", nested: { token: "t", ok: 1 } });
  assert.equal(b.password, "•••redacted•••");
  assert.equal(b.nested.token, "•••redacted•••");
  assert.equal(b.nested.ok, 1);
});

test("detectAuth reads bearer and api keys", () => {
  assert.equal(detectAuth({ authorization: "Bearer x" }).type, "bearer");
  assert.equal(detectAuth({ "x-api-key": "k" }).type, "apiKey");
  assert.equal(detectAuth({}), null);
});

const entries = [
  { id: "1", ts: 1000, method: "GET", url: "https://api.example.com/users/42?full=true", requestHeaders: { Authorization: "Bearer z" }, requestBody: null, status: 200, responseHeaders: {}, responseBody: { id: 42, name: "Kevin" }, durationMs: 50, sizeBytes: 30, transport: "fetch" },
  { id: "2", ts: 2000, method: "GET", url: "https://api.example.com/users/43", requestHeaders: {}, requestBody: null, status: 200, responseHeaders: {}, responseBody: { id: 43, name: "Ana", extra: true }, durationMs: 40, sizeBytes: 40, transport: "xhr" },
  { id: "3", ts: 3000, method: "POST", url: "https://api.example.com/users", requestHeaders: {}, requestBody: { name: "New", age: 30 }, status: 201, responseHeaders: {}, responseBody: { id: 44 }, durationMs: 60, sizeBytes: 10, transport: "fetch" },
];

test("groupEndpoints merges calls into templated endpoints with schemas", () => {
  const eps = groupEndpoints(entries);
  assert.equal(eps.length, 2);
  const get = eps.find((e) => e.method === "GET");
  assert.equal(get.template, "/users/{id}");
  assert.equal(get.callCount, 2);
  assert.equal(get.auth.type, "bearer");
  assert.equal(get.query.full.required, false); // only 1 of 2 calls had it
  assert.equal(get.responseSchema.properties.name.type, "string");
  const post = eps.find((e) => e.method === "POST");
  assert.equal(post.requestSchema.properties.age.type, "integer");
});

test("generators produce plausible output", () => {
  const eps = groupEndpoints(entries);
  const spec = buildOpenApi({ origin: "https://api.example.com", endpoints: eps });
  assert.equal(spec.openapi, "3.1.0");
  assert.ok(spec.paths["/users/{id}"].get);
  assert.equal(spec.paths["/users/{id}"].get.parameters[0].name, "id");
  const ts = buildTsClient({ origin: "https://api.example.com", endpoints: eps });
  assert.match(ts, /export async function getUsersById/);
  assert.match(ts, /BASE_URL = "https:\/\/api.example.com"/);
  const py = buildPyClient({ origin: "https://api.example.com", endpoints: eps });
  assert.match(py, /class ApiClient/);
  assert.match(py, /def get_users_by_id/);
  const har = buildHar({ pageUrl: "https://example.com", entries });
  assert.equal(har.log.entries.length, 3);
  const curl = buildCurl(entries[0]);
  assert.match(curl, /curl -X GET/);
  assert.match(curl, /redacted/);
});

test("noise classification flags telemetry and static assets", () => {
  const [ep] = groupEndpoints([
    { id: "a", ts: 1, method: "POST", url: "https://www.google-analytics.com/g/collect?v=2", requestHeaders: {}, requestBody: null, status: 204, responseHeaders: {}, responseBody: null, durationMs: 1, sizeBytes: 0, transport: "beacon" },
    { id: "b", ts: 2, method: "GET", url: "https://api.example.com/app.js", requestHeaders: {}, requestBody: null, status: 200, responseHeaders: {}, responseBody: null, durationMs: 1, sizeBytes: 0, transport: "fetch" },
    ...entries,
  ]);
  assert.ok(ep.noise === undefined); // raw grouping doesn't tag
  const tagged = tagNoise(groupEndpoints(entries));
  assert.equal(tagged.every((e) => e.noise === null), true);
  assert.match(noiseReason({ origin: "https://www.google-analytics.com", template: "/g/collect" }), /telemetry host/);
  assert.match(noiseReason({ origin: "https://api.example.com", template: "/static/app.js" }), /static asset/);
});

test("JS and Go generators produce plausible clients", () => {
  const eps = groupEndpoints(entries);
  const auth = sessionAuthOf(eps, entries);
  assert.equal(auth.type, "bearer");
  const authWithSecret = sessionAuthOf(eps, entries, true);
  assert.equal(authWithSecret.value, "Bearer z");
  const js = buildJsClient({ origin: "https://api.example.com", endpoints: eps, sessionAuth: auth });
  assert.match(js, /export async function getUsersById/);
  assert.match(js, /AUTH_HEADERS/);
  assert.doesNotMatch(js, /Bearer z/); // placeholder without include-secrets
  const go = buildGoClient({ origin: "https://api.example.com", endpoints: eps, sessionAuth: auth });
  assert.match(go, /package apiclient/);
  assert.match(go, /func GetUsersById/);
  assert.match(go, /type GetUsersByIdResponse struct/);
  const ts = buildTsClient({ origin: "https://api.example.com", endpoints: eps, sessionAuth: auth });
  assert.match(ts, /AUTH_HEADERS/);
  assert.doesNotMatch(ts, /Bearer z/);
  assert.equal(epFnName({ ...eps[0], fnName: "fetchUser" }), "fetchUser");
});

test("sessionStats counts requests, endpoints, errors", () => {
  const s = sessionStats([...entries, { ...entries[0], id: "9", status: 500 }]);
  assert.equal(s.requests, 4);
  assert.equal(s.errors, 1);
  assert.ok(s.endpoints >= 2);
});
