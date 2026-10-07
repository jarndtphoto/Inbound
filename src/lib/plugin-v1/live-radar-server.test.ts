import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createLiveRadarServer, LIVE_GET_FLIGHT_TOOL, LIVE_RADAR_TOOL, LIVE_RESOLVE_TOOL,
} from "./live-radar-server";
import { areaDefinition } from "./areas";
import type { InboundAirborneSource } from "./live-airborne-source.server";

const now = "2026-10-07T01:00:00.000Z";
const unavailableNearby = {
  area: areaDefinition("preset:chicago"), collectionVersion: null, health: "unavailable", generatedAt: now,
  radarTargets: [], featuredFlights: [], status: "Nearby aircraft data is temporarily unavailable.",
  warning: "No current aircraft snapshot is available. Try again shortly.",
} as const;
const unsupported = {
  schemaVersion: "1.0", status: "unsupported", responseAt: now, refreshAfterSeconds: null,
  flightInstanceId: null, flight: null, candidates: [],
  error: { code: "unsupported_aircraft", message: "Airborne-only preview does not include this aircraft." },
} as const;
const servers: import("node:http").Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))));

function fakeSource(log: string[]): InboundAirborneSource {
  return {
    async nearby(input) { log.push(`nearby:${input.area}`); return structuredClone(unavailableNearby) as never; },
    async resolve() { log.push("resolve"); return structuredClone(unsupported) as never; },
    async getFlight() { log.push("flight"); return structuredClone(unsupported) as never; },
  };
}
async function rpc(port: number, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { response, json: await response.json() as any };
}

test("live MCP exposes exactly three read-only airborne tools and only calls Inbound source", async () => {
  const log: string[] = [], live = createLiveRadarServer({ source: fakeSource(log) });
  servers.push(live.server); live.server.listen(0, "127.0.0.1"); await once(live.server, "listening");
  const address = live.server.address(); if (!address || typeof address === "string") throw new Error("Missing live server address");
  const listed = await rpc(address.port, "tools/list");
  assert.deepEqual(listed.json.result.tools.map((tool: any) => tool.name), [LIVE_RADAR_TOOL, LIVE_RESOLVE_TOOL, LIVE_GET_FLIGHT_TOOL]);
  assert.ok(listed.json.result.tools.every((tool: any) => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  assert.equal(listed.response.headers.get("x-inbound-egress"), "inbound-source-only");

  const nearby = await rpc(address.port, "tools/call", { name: LIVE_RADAR_TOOL, arguments: { area: "preset:chicago" } });
  assert.equal(nearby.json.result.structuredContent.health, "unavailable");
  assert.equal(nearby.json.result._meta.liveAirborneOnly, true);

  const resolve = await rpc(address.port, "tools/call", { name: LIVE_RESOLVE_TOOL, arguments: { selectionToken: "A".repeat(43) } });
  assert.equal(resolve.json.result.structuredContent.status, "unsupported");

  const flight = await rpc(address.port, "tools/call", { name: LIVE_GET_FLIGHT_TOOL, arguments: { target: { kind: "lookup", query: "UAL123", date: "2026-10-06" } } });
  assert.equal(flight.json.result.structuredContent.status, "unsupported");
  assert.deepEqual(log, ["nearby:preset:chicago", "resolve", "flight"]);
  assert.equal(live.stats.sourceCalls, 3);
  assert.equal(live.stats.aviationProviderCalls, 0);
});

test("live MCP rejects unknown tools without touching the source", async () => {
  const log: string[] = [], live = createLiveRadarServer({ source: fakeSource(log) });
  servers.push(live.server); live.server.listen(0, "127.0.0.1"); await once(live.server, "listening");
  const address = live.server.address(); if (!address || typeof address === "string") throw new Error("Missing live server address");
  const result = await rpc(address.port, "tools/call", { name: "fetch_provider_directly", arguments: {} });
  assert.equal(result.json.error.code, -32602);
  assert.deepEqual(log, []);
});
