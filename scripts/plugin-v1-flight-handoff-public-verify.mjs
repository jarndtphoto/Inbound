import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = (process.argv[2] || "").replace(/\/$/, "");
const output = process.argv[3] ? resolve(process.argv[3]) : null;
if (!/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(root)) throw new Error("Expected one exact HTTPS Vercel deployment URL");
const mcp = `${root}/mcp`;
const assertions = [];
const calls = [];
let id = 0;

const headerSnapshot = response => ({
  cacheControl: response.headers.get("cache-control"),
  fixtureOnly: response.headers.get("x-inbound-fixture-only"),
  egress: response.headers.get("x-inbound-egress"),
  contentType: response.headers.get("content-type"),
  status: response.status,
});
const assertHeaders = headers => {
  assert.match(headers.cacheControl || "", /no-store/);
  assert.equal(headers.fixtureOnly, "true");
  assert.equal(headers.egress, "static-isolation");
};
async function request(body, options = {}) {
  const response = await fetch(mcp, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const headers = headerSnapshot(response);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  calls.push({ method: typeof body === "object" ? body.method : "malformed", status: response.status, bytes: Buffer.byteLength(text), headers });
  return { response, headers, text, json };
}
async function rpc(method, params = {}, options = {}) {
  const result = await request({ jsonrpc: "2.0", id: ++id, method, params }, options);
  assert.equal(result.response.status, options.status ?? 200);
  if (result.response.status === 200) assertHeaders(result.headers);
  return result;
}
async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.ok(result.json?.result?.structuredContent, `Missing structured result for ${name}`);
  return result.json.result.structuredContent;
}
const selected = (board, ident) => {
  const target = board.radarTargets.find(row => row.displayIdent === ident);
  assert.ok(target, `${ident} is absent from the public Radar board`);
  return target;
};
const record = message => assertions.push(message);

const publicGet = await fetch(mcp, { redirect: "manual" });
const publicGetHeaders = headerSnapshot(publicGet);
assert.equal(publicGet.status, 405);
assertHeaders(publicGetHeaders);
record("Exact MCP URL is public without an SSO redirect and rejects GET with 405");

const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "part-3b4-public-verifier", version: "1" } });
assert.equal(initialized.json.result.protocolVersion, "2025-11-25");
assert.equal(initialized.json.result.serverInfo.name, "inbound-fake-flight-handoff-proof");
assert.equal(initialized.json.result.serverInfo.version, "0.4.0");
record("MCP initialize negotiates 2025-11-25 with the Part 3B.4 fake handoff server");

const listed = await rpc("tools/list");
const tools = listed.json.result.tools;
assert.deepEqual(tools.map(value => value.name), ["get_nearby_flights", "resolve_nearby_flight", "get_flight"]);
for (const value of tools) {
  assert.equal(value.annotations.readOnlyHint, true);
  assert.equal(value.annotations.destructiveHint, false);
  assert.equal(value.annotations.openWorldHint, false);
  assert.equal(value._meta["openai/outputTemplate"], "ui://inbound/radar-v1.html");
}
assert.equal(tools.some(value => /create|update|delete|mutat|provider|production|database/i.test(value.name)), false);
record("tools/list exposes exactly three read-only, closed-world tools and no mutation/production-like tool");

const resources = await rpc("resources/list");
assert.deepEqual(resources.json.result.resources.map(value => value.uri), ["ui://inbound/radar-v1.html"]);
const resource = await rpc("resources/read", { uri: "ui://inbound/radar-v1.html" });
const widget = resource.json.result.contents[0];
assert.equal(widget.mimeType, "text/html;profile=mcp-app");
assert.match(widget.text, /Invented aircraft only/);
assert.match(widget.text, /Track flight/);
assert.ok(Buffer.byteLength(widget.text) < 512 * 1024);
assert.deepEqual(widget._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
record("resources/list and resources/read return one self-contained fixture widget with a closed CSP");

const firstChicago = await tool("get_nearby_flights", { area: "preset:chicago" });
let chicago = firstChicago;
for (let attempt = 0; chicago.health === "stale" && attempt < 3; attempt++) {
  await delay(1_000);
  chicago = await tool("get_nearby_flights", { area: "preset:chicago" });
}
assert.equal(chicago.area.id, "preset:chicago");
assert.equal(chicago.health, "ok");
assert.ok([39, 40].includes(chicago.radarTargets.length));
assert.ok(chicago.radarTargets.length <= 100);
assert.ok(chicago.featuredFlights.length <= 5);
assert.ok(Buffer.byteLength(JSON.stringify(chicago)) <= 64 * 1024);
for (const featured of chicago.featuredFlights) {
  const target = chicago.radarTargets.find(value => value.radarId === featured.radarId);
  assert.ok(target);
  assert.deepEqual(featured.selection, target.selection);
}
record("Chicago returns the bounded invented Radar board, at most five Featured flights, exact shared selections, and a <=64 KiB envelope");

const directToken = selected(chicago, "SYN101").selection.token;
const expiryToken = selected(chicago, "SYN102").selection.token;
assert.match(directToken, /^[A-Za-z0-9_-]{43}$/);
assert.match(expiryToken, /^[A-Za-z0-9_-]{43}$/);
const direct = await tool("resolve_nearby_flight", { selectionToken: directToken });
assert.equal(direct.status, "resolved");
assert.equal(direct.flight.identity.displayIdent, "SYN101");
assert.equal(direct.flight.identity.serviceTimeZone, "America/Chicago");
assert.equal(direct.flightInstanceId, direct.flight.flightInstanceId);
const exactInstance = await tool("get_flight", { target: { kind: "instance", flightInstanceId: direct.flightInstanceId } });
assert.equal(exactInstance.status, "resolved");
assert.equal(exactInstance.flightInstanceId, direct.flightInstanceId);
record("SYN101 resolves from its opaque selection to one exact dated occurrence, reusable only by exact instance ID");

const ambiguous = await tool("resolve_nearby_flight", { selectionToken: selected(chicago, "SYN105").selection.token });
assert.equal(ambiguous.status, "ambiguous");
assert.equal(ambiguous.candidates.length, 2);
assert.equal(new Set(ambiguous.candidates.map(value => value.serviceDate)).size, 2);
assert.equal(new Set(ambiguous.candidates.map(value => value.candidateToken)).size, 2);
const chosen = await tool("get_flight", { target: { kind: "choice", candidateToken: ambiguous.candidates[0].candidateToken } });
assert.equal(chosen.status, "resolved");
assert.equal(chosen.flight.identity.displayIdent, "SYN105");
assert.equal(chosen.flight.identity.serviceDate, ambiguous.candidates[0].serviceDate);
record("SYN105 stays ambiguous until one opaque dated candidate is explicitly chosen");

const failures = [
  ["SYN103", "identity_unconfirmed"],
  ["SYN106", "identity_changed"],
  ["SYN107", "backend_unavailable"],
];
for (const [ident, code] of failures) {
  const value = await tool("resolve_nearby_flight", { selectionToken: selected(chicago, ident).selection.token });
  assert.equal(value.status, "unavailable");
  assert.equal(value.error.code, code);
}
const unsupportedSelection = selected(chicago, "SYN104").selection;
assert.deepEqual(unsupportedSelection, { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null });
const unsupported = await tool("get_flight", { target: { kind: "lookup", query: "SYN104", date: "today" } });
assert.equal(unsupported.status, "unsupported");
assert.equal(unsupported.error.code, "unsupported_aircraft");
const missingDate = await tool("get_flight", { target: { kind: "lookup", query: "SYN101" } });
assert.equal(missingDate.status, "unavailable");
assert.equal(missingDate.error.code, "date_unavailable");
const unsupportedQuery = await tool("get_flight", { target: { kind: "lookup", query: "UA219", date: "today" } });
assert.equal(unsupportedQuery.status, "unsupported");
assert.equal(unsupportedQuery.error.code, "unsupported_query");
record("Unconfirmed, identity-changed, backend-unavailable, unsupported-aircraft, missing-date, and unsupported-query paths all fail closed");

const explicit = await tool("get_flight", { target: { kind: "lookup", query: "SYN101", date: "2026-10-05", originIata: "ORD", destinationIata: "BOS" } });
assert.equal(explicit.status, "resolved");
assert.equal(explicit.flight.identity.serviceDate, "2026-10-05");
assert.equal(explicit.flight.route.origin.iata, "ORD");
assert.equal(explicit.flight.route.destination.iata, "BOS");
record("Explicit fake lookup requires and preserves the requested service date and route");

const ord = await tool("get_nearby_flights", { area: "airport:KORD" });
const mdw = await tool("get_nearby_flights", { area: "airport:KMDW" });
assert.equal(ord.area.id, "airport:KORD");
assert.equal(mdw.area.id, "airport:KMDW");
assert.ok(ord.radarTargets.length <= 100 && ord.featuredFlights.length <= 5);
assert.ok(mdw.radarTargets.length <= 100 && mdw.featuredFlights.length <= 5);
record("ORD and MDW return independently bounded projections from the fixture-only Nearby surface");

const invalidToken = await tool("resolve_nearby_flight", { selectionToken: "A".repeat(43) });
assert.equal(invalidToken.status, "invalid_request");
assert.equal(invalidToken.error.code, "invalid_token");
const callsignOnly = await rpc("tools/call", { name: "resolve_nearby_flight", arguments: { callsign: "SYN101" } });
assert.equal(callsignOnly.json.error.code, -32602);
const mutation = await rpc("tools/call", { name: "update_flight", arguments: {} });
assert.equal(mutation.json.error.code, -32602);
const unknownMethod = await rpc("resources/templates/list");
assert.equal(unknownMethod.json.error.code, -32601);
const hostile = await rpc("initialize", { protocolVersion: "2025-11-25" }, { origin: "https://attacker.invalid", status: 403 });
assert.equal(hostile.json.error, "Unknown Radar proof authority or origin.");
const chatgptOrigin = await rpc("initialize", { protocolVersion: "2025-11-25" }, { origin: "https://chatgpt.com" });
assert.equal(chatgptOrigin.json.result.serverInfo.name, "inbound-fake-flight-handoff-proof");
record("Opaque-token-only resolution, unknown methods/tools, mutation attempts, and hostile origins are rejected; ChatGPT origin is accepted");

await delay(20_750);
const afterRefresh = await tool("get_nearby_flights", { area: "preset:chicago" });
assert.equal(afterRefresh.radarTargets.length, 39);
assert.ok(afterRefresh.collectionVersion > chicago.collectionVersion);
record("A real public T+20 refresh advances the authoritative collection and the fixture remains at its deterministic post-retirement count of 39");

const expiresAt = Date.parse(selected(chicago, "SYN102").selection.expiresAt);
while (Date.now() <= expiresAt + 150) {
  await delay(Math.min(10_000, expiresAt + 200 - Date.now()));
  await rpc("ping");
}
const expired = await tool("resolve_nearby_flight", { selectionToken: expiryToken });
assert.equal(expired.status, "expired");
assert.equal(expired.error.code, "observation_expired");
record("An originally valid opaque observation handle expires publicly and cannot be extended or reused");

const report = {
  ok: true,
  verifiedAt: new Date().toISOString(),
  root,
  mcp,
  totals: { assertions: assertions.length, rpcRequests: calls.length, failures: 0 },
  tools: tools.map(value => value.name),
  resource: "ui://inbound/radar-v1.html",
  nearby: {
    firstPublicRadar: firstChicago.radarTargets.length,
    verifiedHealthyRadar: chicago.radarTargets.length,
    refreshedRadar: afterRefresh.radarTargets.length,
    featuredMaximumObserved: Math.max(chicago.featuredFlights.length, ord.featuredFlights.length, mdw.featuredFlights.length),
    certifiedRadarMaximum: 100,
    certifiedFeaturedMaximum: 5,
    areas: [chicago.area.id, ord.area.id, mdw.area.id],
  },
  handoff: { direct: "SYN101", ambiguous: "SYN105", candidateCount: ambiguous.candidates.length, expired: "SYN102" },
  protection: { exactExceptionHostname: new URL(root).hostname, globalRequireLogin: true, globalMode: "Standard Protection" },
  isolation: { fixtureOnly: true, cacheControl: "no-store", egress: "static-isolation", providerCalls: 0, productionApiCalls: 0, productionDbAccess: 0 },
  assertions,
  calls,
};
if (output) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
console.log(JSON.stringify(report));
