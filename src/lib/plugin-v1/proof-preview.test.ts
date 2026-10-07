import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import fixturePreview from "./proof-preview";
import { NearbyFlightsResponseV1Schema } from "./contracts";

const host = "inbound-live-fixture-test.vercel.app";
async function read(method: string, params: Record<string, unknown> = {}, path = "/mcp", verb = "POST", origin?: string) {
  const req = Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })]) as unknown as IncomingMessage;
  req.url = path; req.method = verb;
  req.headers = { host, "content-type": "application/json", accept: "application/json, text/event-stream", ...(origin ? { origin } : {}) };
  let status = 200; let body = ""; const headers: Record<string, string> = {};
  const res = { headersSent: false, setHeader: (k: string, v: string) => { headers[k] = v; }, writeHead: (s: number, h: Record<string, string> = {}) => { status = s; Object.assign(headers, h); }, end: (v = "") => { body = v; } } as unknown as ServerResponse;
  await fixturePreview(req, res);
  return { status, headers, body, json: body.startsWith("{") ? JSON.parse(body) : null };
}
test("Preview is read-only, fixture-only, bounded, and fails closed for production, secrets and expired test windows", async () => {
  const previous = process.env;
  process.env = { VERCEL_ENV: "preview", VERCEL_URL: host };
  try {
    assert.equal((await read("initialize", { protocolVersion: "2025-11-25" })).status, 200);
    const tools = (await read("tools/list")).json.result.tools;
    assert.equal(tools.length, 1); assert.equal(tools[0].name, "fixture_get_nearby_flights");
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const resources = (await read("resources/list")).json.result.resources;
    assert.equal(resources.length, 1); assert.equal(resources[0].uri, "ui://inbound/fixture-live-v1.html");
    const html = (await read("resources/read", { uri: resources[0].uri })).json.result.contents[0].text;
    assert.match(html, /STATIC FIXTURES/); assert.doesNotMatch(html, /__INITIAL_FIXTURE__|__PROOF_NONCE__/);
    const a = await read("tools/call", { name: tools[0].name, arguments: { area: { kind: "preset", nameOrId: "chicago" } } });
    const b = await read("tools/call", { name: tools[0].name, arguments: { area: { kind: "preset", nameOrId: "chicago" } } });
    assert.equal(NearbyFlightsResponseV1Schema.parse(a.json.result.structuredContent).flights.length, 4);
    assert.deepEqual(a.json.result.structuredContent, b.json.result.structuredContent, "new reads preserve static observations");
    assert.notEqual(a.json.result._meta.fixtureReadId, b.json.result._meta.fixtureReadId);
    assert.equal(b.json.result._meta.fixtureReadSequence, a.json.result._meta.fixtureReadSequence + 1);
    assert.equal(a.headers["X-Inbound-Egress"], "static-isolation");
    assert.equal((await read("tools/call", { name: "get_flight" })).json.error.code, -32602);
    assert.equal((await read("resources/read", { uri: "file:///etc/passwd" })).json.error.code, -32602);
    assert.equal((await read("delete", {})).json.error.code, -32601);
    assert.equal((await read("tools/list", {}, "/api/public/v1/nearby-flights")).status, 404);
    assert.equal((await read("tools/list", {}, "/mcp", "DELETE")).status, 405);
    assert.equal((await read("tools/list", {}, "/mcp", "POST", "https://untrusted.example")).status, 403);
    assert.equal((await read("tools/list", {}, "/api/mcp")).status, 200);
    for (const key of ["DATABASE_URL", "FR24_API_KEY", "FLIGHTSTATS_APP_KEY", "ADSBDB_URL", "WEATHER_API_KEY", "FAA_TOKEN", "INBOUND_API_SECRET"]) {
      process.env[key] = "unshipped-test-secret";
      const result = await read("tools/list"); assert.equal(result.status, 503); assert.ok(!result.body.includes("unshipped-test-secret"));
      delete process.env[key];
    }
    process.env.VERCEL_ENV = "production"; assert.equal((await read("tools/list")).status, 503);
    process.env.VERCEL_ENV = "preview";
    const originalNow = Date.now; Date.now = () => Date.parse("2026-10-11T00:00:00.000Z");
    try { assert.equal((await read("tools/list")).status, 503); } finally { Date.now = originalNow; }
  } finally { process.env = previous; }
});
test("Fixture import leaves host transport and instrumentation writable", async () => {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const requestDescriptor = Object.getOwnPropertyDescriptor(http, "request");
  await import("./proof-preview");
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "fetch"), fetchDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(http, "request"), requestDescriptor);
  assert.doesNotThrow(() => { globalThis.fetch = globalThis.fetch; http.request = http.request; });
});
