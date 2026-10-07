import { once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FlightResultV1Schema } from "./contracts";
import { createRadarProofServer, GET_FLIGHT_TOOL, RADAR_PROOF_TOOL, RESOLVE_NEARBY_TOOL } from "./radar-proof-server";
import { InboundNearbyResponseSchema, PUBLIC_NEARBY_PAYLOAD_BYTES } from "./nearby-response";

const epoch = Date.parse("2026-10-04T03:00:06.000Z");
async function proofRun(run: (input: { proof: Awaited<ReturnType<typeof createRadarProofServer>>; url: string; setClock: (value: number) => void }) => Promise<void>) {
  let now = epoch; const proof = await createRadarProofServer({ clock: () => now });
  proof.server.listen(0, "127.0.0.1"); await once(proof.server, "listening");
  const address = proof.server.address(); assert.ok(address && typeof address !== "string");
  try { await run({ proof, url: `http://127.0.0.1:${address.port}`, setClock: value => { now = value; } }); }
  finally { proof.dispose(); proof.server.closeAllConnections(); await new Promise<void>(resolve => proof.server.close(() => resolve())); }
}
async function tool(url: string, name: string, args: object, id = 1) {
  const response = await fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.error, undefined); return body.result.structuredContent;
}

test("opaque Nearby selection resolves SYN101 once under 100 contenders and reuses one exact detail occurrence", async () => {
  await proofRun(async ({ proof, url }) => {
    const board = InboundNearbyResponseSchema.parse(await tool(url, RADAR_PROOF_TOOL, { area: "preset:chicago", limit: 5 }));
    const target = board.radarTargets.find(value => value.displayIdent === "SYN101")!;
    assert.equal(target.selection.state, "unresolved"); assert.match(target.selection.token!, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(target.selection.expiresAt!) <= Date.parse(target.observedAt) + 120_000);
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) => tool(url, RESOLVE_NEARBY_TOOL,
      { selectionToken: target.selection.token }, index + 10).then(FlightResultV1Schema.parse)));
    assert.ok(results.every(result => result.status === "resolved"));
    // 03:00Z is still the prior Chicago service day; the occurrence must not
    // inherit the server's UTC calendar date.
    assert.ok(results.every(result => result.flight!.identity.serviceDate === "2026-10-03"));
    assert.equal(new Set(results.map(result => result.flightInstanceId)).size, 1);
    assert.equal(proof.handoff.diagnostics().resolutionBuilds, 1); assert.equal(proof.handoff.diagnostics().detailBuilds, 1);
    const instance = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "instance", flightInstanceId: results[0].flightInstanceId } }));
    assert.equal(instance.flightInstanceId, results[0].flightInstanceId); assert.equal(proof.handoff.diagnostics().detailBuilds, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(results[0])) <= PUBLIC_NEARBY_PAYLOAD_BYTES);
    const json = JSON.stringify(results[0]);
    for (const forbidden of ["privateAircraftIdentity", "sessionKey", "token_hash", "leaseOwner", "fencingGeneration", "providerUrl", "rawProviderPayload"])
      assert.equal(json.includes(forbidden), false, forbidden);
  });
});

test("SYN105 ambiguity uses two dated opaque choices and never auto-picks", async () => {
  await proofRun(async ({ url }) => {
    const board = InboundNearbyResponseSchema.parse(await tool(url, RADAR_PROOF_TOOL, { area: "preset:chicago", limit: 5 }));
    const target = board.radarTargets.find(value => value.displayIdent === "SYN105")!;
    const ambiguous = FlightResultV1Schema.parse(await tool(url, RESOLVE_NEARBY_TOOL, { selectionToken: target.selection.token }));
    assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.candidates.length, 2);
    assert.equal(new Set(ambiguous.candidates.map(value => value.serviceDate)).size, 2);
    assert.deepEqual(ambiguous.candidates.map(value => value.serviceDate), ["2026-10-03", "2026-10-04"]);
    const chosen = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "choice", candidateToken: ambiguous.candidates[1].candidateToken } }));
    assert.equal(chosen.status, "resolved"); assert.equal(chosen.flight!.identity.serviceDate, ambiguous.candidates[1].serviceDate);
    const repeat = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "choice", candidateToken: ambiguous.candidates[1].candidateToken } }));
    assert.equal(repeat.flightInstanceId, chosen.flightInstanceId);
  });
});

test("unconfirmed, identity-changed, unsupported, outage, invalid and expired paths fail closed", async () => {
  await proofRun(async ({ proof, url, setClock }) => {
    const board = InboundNearbyResponseSchema.parse(await tool(url, RADAR_PROOF_TOOL, { area: "preset:chicago", limit: 5 }));
    const selected = (ident: string) => board.radarTargets.find(value => value.displayIdent === ident)!;
    assert.deepEqual(selected("SYN104").selection, { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null });
    const expected = [["SYN103", "identity_unconfirmed"], ["SYN106", "identity_changed"], ["SYN107", "backend_unavailable"]] as const;
    for (const [ident, code] of expected) {
      const result = FlightResultV1Schema.parse(await tool(url, RESOLVE_NEARBY_TOOL, { selectionToken: selected(ident).selection.token }));
      assert.equal(result.status, "unavailable"); assert.equal(result.error!.code, code);
    }
    const outageRepeat = FlightResultV1Schema.parse(await tool(url, RESOLVE_NEARBY_TOOL, { selectionToken: selected("SYN107").selection.token }));
    assert.equal(outageRepeat.error!.code, "backend_unavailable");
    const unsupported = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "lookup", query: "SYN104", date: "today" } }));
    assert.equal(unsupported.status, "unsupported"); assert.equal(unsupported.error!.code, "unsupported_aircraft");
    const invalid = FlightResultV1Schema.parse(await tool(url, RESOLVE_NEARBY_TOOL, { selectionToken: "A".repeat(43) }));
    assert.equal(invalid.status, "invalid_request"); assert.equal(invalid.error!.code, "invalid_token");
    const expiring = selected("SYN102").selection; setClock(Date.parse(expiring.expiresAt!));
    const expired = FlightResultV1Schema.parse(await tool(url, RESOLVE_NEARBY_TOOL, { selectionToken: expiring.token }));
    assert.equal(expired.status, "expired"); assert.equal(expired.error!.code, "observation_expired");
    assert.deepEqual(proof.handoff.diagnostics(), { ...proof.handoff.diagnostics(), providerCalls: 0, productionApiCalls: 0, productionDbAccess: 0 });
  });
});

test("fake lookup requires an explicit date and stable dated occurrences do not collide", async () => {
  await proofRun(async ({ url }) => {
    const missingDate = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "lookup", query: "SYN101" } }));
    assert.equal(missingDate.error!.code, "date_unavailable");
    const first = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "lookup", query: "SYN101", date: "2026-10-04", originIata: "ORD", destinationIata: "BOS" } }));
    const repeat = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "lookup", query: "SYN101", date: "2026-10-04", originIata: "ORD", destinationIata: "BOS" } }));
    const nextDay = FlightResultV1Schema.parse(await tool(url, GET_FLIGHT_TOOL, { target: { kind: "lookup", query: "SYN101", date: "2026-10-05", originIata: "ORD", destinationIata: "BOS" } }));
    assert.equal(first.flightInstanceId, repeat.flightInstanceId); assert.notEqual(first.flightInstanceId, nextDay.flightInstanceId);
  });
});
