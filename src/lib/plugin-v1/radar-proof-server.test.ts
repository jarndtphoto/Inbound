import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRadarProofServer, RADAR_PROOF_RESOURCE, RADAR_PROOF_TOOL } from "./radar-proof-server";
import { InboundNearbyResponseSchema, PUBLIC_NEARBY_PAYLOAD_BYTES } from "./nearby-response";

const epoch = Date.parse("2026-10-04T03:00:06.000Z");
async function withProof(run: (proof: Awaited<ReturnType<typeof createRadarProofServer>>, url: string, setClock: (at: number) => void) => Promise<void>) {
  let now = epoch;
  const proof = await createRadarProofServer({ clock: () => now });
  proof.server.listen(0, "127.0.0.1"); await once(proof.server, "listening");
  const address = proof.server.address(); assert.ok(address && typeof address !== "string");
  try { await run(proof, `http://127.0.0.1:${address.port}`, at => { now = at; }); }
  finally { proof.dispose(); proof.server.closeAllConnections(); await new Promise<void>(resolve => proof.server.close(() => resolve())); }
}
async function rpc(url: string, method: string, params: Record<string, unknown> = {}, id: string | number | undefined = 1) {
  const response = await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }) });
  assert.equal(response.headers.get("x-inbound-fixture-only"), "true");
  assert.equal(response.headers.get("x-inbound-egress"), "static-isolation");
  return { response, body: response.status === 202 ? null : await response.json() };
}

test("New MCP proof exposes one Nearby tool and one self-contained UI through the real serializer", async () => {
  await withProof(async (proof, url) => {
    const init = await rpc(url, "initialize", { protocolVersion: "2025-11-25" });
    assert.equal(init.body.result.serverInfo.name, "inbound-fake-radar-proof");
    const tools = (await rpc(url, "tools/list")).body.result.tools;
    assert.equal(tools.length, 1); assert.equal(tools[0].name, RADAR_PROOF_TOOL);
    assert.equal(tools[0].annotations.openWorldHint, false);
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.equal(tools[0]._meta.ui.resourceUri, RADAR_PROOF_RESOURCE);
    const resources = (await rpc(url, "resources/list")).body.result.resources;
    assert.equal(resources.length, 1); assert.equal(resources[0].uri, RADAR_PROOF_RESOURCE);
    const resource = (await rpc(url, "resources/read", { uri: RADAR_PROOF_RESOURCE })).body.result.contents[0];
    assert.equal(resource.mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.ok(!/__INITIAL_NEARBY__|__RADAR_WIDGET_JS__|__PROOF_NONCE__/.test(resource.text));
    assert.ok(!/<script[^>]*src=/.test(resource.text));
    const widget = await fetch(url + "/widget");
    assert.equal(widget.status, 200); assert.equal(widget.headers.get("cache-control"), "no-store");
    assert.match(widget.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.equal(proof.stats.aviationProviderCalls, 0);
    assert.equal(proof.stats.productionApiCalls, 0); assert.equal(proof.stats.productionDbAccess, 0);
  });
});

test("100 MCP viewers reuse one invented collection without multiplying explicit route work", async () => {
  await withProof(async (proof, url, setClock) => {
    const initialized = proof.service.diagnostics();
    assert.equal(initialized.fakeAcquisitions, 1); assert.equal(initialized.fakeRouteLookups, 2);
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => rpc(url, "tools/call", { name: RADAR_PROOF_TOOL, arguments: { area: "preset:chicago" } }, index + 1)));
    for (const response of responses) {
      assert.equal(response.response.status, 200);
      const data = InboundNearbyResponseSchema.parse(response.body.result.structuredContent);
      assert.equal(data.radarTargets.length, 40); assert.equal(data.featuredFlights.length, 4);
      assert.equal(data.collectionVersion, 1);
      assert.ok(Buffer.byteLength(JSON.stringify(response.body)) <= PUBLIC_NEARBY_PAYLOAD_BYTES);
      for (const field of ["privateAircraftIdentity", "registration", "sessionKey", "phaseEvidence", "providerEndpoint", "routeCacheKey", "constructionBudget", "occurrenceId", "selectionToken"]) {
        assert.equal(JSON.stringify(data).includes(field), false, field);
      }
    }
    assert.equal(proof.service.diagnostics().fakeAcquisitions, 1);
    assert.equal(proof.service.diagnostics().fakeRouteLookups, initialized.fakeRouteLookups);
    for (const area of ["airport:KORD", "airport:KMDW"] as const) {
      const data = (await rpc(url, "tools/call", { name: RADAR_PROOF_TOOL, arguments: { area, limit: 5 } })).body.result.structuredContent;
      assert.equal(data.collectionVersion, 1); assert.equal(data.radarTargets.length, 40); assert.equal(data.featuredFlights.length, 5);
    }
    setClock(epoch + 20_000);
    const update = (await rpc(url, "tools/call", { name: RADAR_PROOF_TOOL, arguments: { area: "preset:chicago" } })).body.result.structuredContent;
    assert.equal(update.collectionVersion, 2); assert.equal(update.radarTargets.length, 39);
    assert.equal(proof.service.diagnostics().fakeAcquisitions, 2);
    assert.equal(proof.service.diagnostics().fakeRouteLookups, initialized.fakeRouteLookups);
    assert.equal(proof.service.diagnostics().providerApiCalls, 0);
  });
});

test("MCP rejects unsupported tools, coordinates, routes, raw resources, methods and foreign origins", async () => {
  await withProof(async (proof, url) => {
    const before = proof.service.diagnostics();
    for (const args of [{ area: "airport:KJFK" }, { area: "preset:chicago", radiusNm: 50 }, { area: "preset:chicago", limit: 6 }, { area: "preset:chicago", latitude: 41.9, longitude: -87.8 }, { area: "preset:chicago", provider: "live" }]) {
      assert.equal((await rpc(url, "tools/call", { name: RADAR_PROOF_TOOL, arguments: args })).body.error.code, -32602);
    }
    for (const name of ["get_flight", "track_flight", "lookup_route", "fixture_get_nearby_flights"]) assert.equal((await rpc(url, "tools/call", { name, arguments: {} })).body.error.code, -32602);
    assert.equal((await rpc(url, "resources/read", { uri: "file:///etc/passwd" })).body.error.code, -32602);
    assert.equal((await rpc(url, "radar/write")).body.error.code, -32601);
    assert.equal((await fetch(url + "/mcp")).status, 405);
    assert.equal((await fetch(url + "/widget", { headers: { Origin: "https://foreign.example" } })).status, 403);
    assert.equal((await fetch(url + "/api/flight")).status, 404);
    assert.equal(proof.service.diagnostics().fakeAcquisitions, before.fakeAcquisitions);
    assert.equal(proof.service.diagnostics().fakeRouteLookups, before.fakeRouteLookups);
  });
});
