import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { Script } from "node:vm";
import { createFixtureProofServer, proofFixtureResult, proofWidgetHtml, PROOF_RESOURCE, PROOF_TOOL, UI_MIME } from "./proof-server";
import { NearbyFlightsResponseV1Schema } from "./contracts";

test("Fixture tool never resolves flights, preserves nulls, and honors area/presentation input", () => {
  const result = proofFixtureResult({ area: { kind: "airport", code: "ORD" }, limit: 2, includePosition: true, radiusNm: 25 });
  const r = NearbyFlightsResponseV1Schema.parse(result.structuredContent);
  assert.equal(r.resolvedArea!.id, "airport:KORD"); assert.equal(r.resolvedArea!.radiusNm, 25); assert.equal(r.flights.length, 2);
  assert.ok(r.flights.every(f => f.position?.kind === "observed")); assert.equal(result._meta.fixtureOnly, true);
  assert.equal(proofFixtureResult({ area: { kind: "airport", code: "JFK" } }).structuredContent.status, "invalid_request");
  assert.deepEqual(proofFixtureResult({ area: { kind: "preset", nameOrId: "chicago" } }), proofFixtureResult({ area: { kind: "preset", nameOrId: "chicago" } }), "static reads do not change observation times");
});
test("Self-contained UI resource has valid JS, safe fixture text and explicit host fallback", () => {
  const html = proofWidgetHtml("fixture-test-nonce");
  assert.match(html, /STATIC FIXTURES/); assert.match(html, /ChatGPT.*unverified/); assert.doesNotMatch(html, /__INITIAL_FIXTURE__|__PROOF_NONCE__/);
  const js = html.match(/<script nonce="fixture-test-nonce">([\s\S]*?)<\/script>/)![1]!;
  assert.doesNotThrow(() => new Script(js));
  assert.doesNotMatch(html, /<script[^>]*\bsrc=|<link[^>]*\bhref=|sendFollowUpMessage|sampling\/createMessage/);
});
test("Local MCP protocol discovery, UI metadata, JSON transport and safety boundaries", async () => {
  const { server, stats } = createFixtureProofServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const root = `http://127.0.0.1:${address.port}`;
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`${root}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); assert.equal(response.status, 200); return (await response.json()) as { result: Record<string, any>; error?: { code: number } };
  };
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-test", version: "1" } }); assert.equal(init.result.protocolVersion, "2025-11-25");
    const note = await fetch(`${root}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }); assert.equal(note.status, 202); assert.equal(await note.text(), "");
    const tools = await rpc("tools/list"); assert.equal(tools.result.tools.length, 1); assert.equal(tools.result.tools[0].name, PROOF_TOOL); assert.equal(tools.result.tools[0]._meta.ui.resourceUri, PROOF_RESOURCE); assert.deepEqual(tools.result.tools[0]._meta.ui.visibility, ["model", "app"]);
    const resource = await rpc("resources/read", { uri: PROOF_RESOURCE }); assert.equal(resource.result.contents[0].mimeType, UI_MIME); assert.deepEqual(resource.result.contents[0]._meta["openai/ui"].availableDisplayModes, ["inline", "pip", "fullscreen"]);
    const result = await rpc("tools/call", { name: PROOF_TOOL, arguments: { area: { kind: "preset", nameOrId: "chicago" } } }); assert.equal(NearbyFlightsResponseV1Schema.parse(result.result.structuredContent).flights.length, 4); assert.equal(stats.toolCalls, 1);
    const invalid = await rpc("tools/call", { name: PROOF_TOOL, arguments: { area: null, providerKey: "secret" } }); assert.equal(invalid.result.structuredContent.status, "invalid_request"); assert.ok(!JSON.stringify(invalid).includes("secret"));
    assert.equal((await rpc("tools/call", { name: "get_flight", arguments: {} })).error!.code, -32602);
    assert.equal((await fetch(`${root}/mcp`)).status, 405);
    assert.equal((await fetch(`${root}/api/public/v1/nearby-flights`)).status, 404);
    assert.equal((await fetch(`${root}/mcp`, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: "{}" })).status, 403);
    const spoofedHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${root}/mcp`, { method: "POST", headers: { ...headers, Host: "untrusted.example" } }, response => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(spoofedHost, 403);
    assert.equal((await fetch(`${root}/mcp`, { method: "POST", headers, body: "x".repeat(8193) })).status, 413);
    const malformed = await fetch(`${root}/mcp`, { method: "POST", headers, body: "not-json" }); assert.equal(((await malformed.json()) as any).error.code, -32700);
    const html = await fetch(`${root}/widget`); assert.equal(html.status, 200); assert.ok(html.headers.get("Content-Security-Policy")!.includes("default-src 'none'"));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
