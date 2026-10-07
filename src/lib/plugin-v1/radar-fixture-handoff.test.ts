import { test } from "node:test";
import assert from "node:assert/strict";
import { createRadarProofHandler } from "./radar-proof-server";

const epoch = Date.parse("2026-10-05T13:00:06Z");
const fixtureAuthority = { authority: "independent-worker-test-authority", realm: "same-fixture.vercel.app" };
async function workers(run: (input: { a: Awaited<ReturnType<typeof createRadarProofHandler>>; b: Awaited<ReturnType<typeof createRadarProofHandler>>; setClock: (at: number) => void }) => Promise<void>) {
  let now = epoch;
  const a = await createRadarProofHandler({ clock: () => now, fixtureAuthority });
  now += 3_000; const b = await createRadarProofHandler({ clock: () => now, fixtureAuthority });
  try { await run({ a, b, setClock: at => { now = at; } }); } finally { a.dispose(); b.dispose(); }
}
async function board(proof: Awaited<ReturnType<typeof createRadarProofHandler>>) {
  return proof.handoff.issueSelections(await proof.service.request("preset:chicago"));
}
const id = (index: number) => `00000000-0000-4000-8000-${(16000 + index).toString(16).padStart(12, "0")}`;

test("fixture selection, both dated choices and exact instance survive independent workers", async () => {
  await workers(async ({ a, b }) => {
    const selected = await board(a);
    const direct = await b.handoff.resolveNearby({ selectionToken: selected.get(id(0))!.token });
    assert.equal(direct.status, "resolved"); assert.equal(direct.flight!.identity.displayIdent, "SYN101");
    const instance = await a.handoff.getFlight({ target: { kind: "instance", flightInstanceId: direct.flightInstanceId } });
    assert.equal(instance.status, "resolved"); assert.equal(instance.flightInstanceId, direct.flightInstanceId);
    const ambiguous = await b.handoff.resolveNearby({ selectionToken: selected.get(id(4))!.token });
    assert.equal(ambiguous.status, "ambiguous"); assert.equal(ambiguous.candidates.length, 2);
    for (const candidate of ambiguous.candidates) {
      assert.match(candidate.candidateToken, /^[A-Za-z0-9_-]{43}$/);
      const chosen = await a.handoff.getFlight({ target: { kind: "choice", candidateToken: candidate.candidateToken } });
      assert.equal(chosen.status, "resolved"); assert.equal(chosen.flight!.identity.serviceDate, candidate.serviceDate);
      assert.equal(chosen.flight!.identity.displayIdent, "SYN105");
      const cold = await b.handoff.getFlight({ target: { kind: "instance", flightInstanceId: chosen.flightInstanceId } });
      assert.equal(cold.flightInstanceId, chosen.flightInstanceId);
    }
  });
});

test("fixture handles reject tampering, kind substitution and a different deployment", async () => {
  await workers(async ({ a, b }) => {
    const selected = await board(a), token = selected.get(id(4))!.token!;
    const bytes = Buffer.from(token, "base64url"); bytes[0] = bytes[0]! + 1;
    const tampered = await b.handoff.resolveNearby({ selectionToken: bytes.toString("base64url") });
    assert.equal(tampered.error!.code, "invalid_token");
    assert.equal((await b.handoff.getFlight({ target: { kind: "choice", candidateToken: token } })).error!.code, "invalid_token");
    const ambiguous = await b.handoff.resolveNearby({ selectionToken: token });
    assert.equal((await a.handoff.resolveNearby({ selectionToken: ambiguous.candidates[0]!.candidateToken })).error!.code, "invalid_token");
    const other = await createRadarProofHandler({ clock: () => epoch + 3_000, fixtureAuthority: { ...fixtureAuthority, realm: "different-fixture.vercel.app" } });
    try { assert.equal((await other.handoff.resolveNearby({ selectionToken: token })).error!.code, "invalid_token"); } finally { other.dispose(); }
    assert.equal((await b.handoff.resolveNearby({ selectionToken: "A".repeat(43) })).error!.code, "invalid_token");
  });
});

test("worker restart and repeated resolution cannot extend observation or choice expiry", async () => {
  await workers(async ({ a, b, setClock }) => {
    const selected = await board(a), token = selected.get(id(4))!.token!;
    const first = await a.handoff.resolveNearby({ selectionToken: token });
    const expiresAt = selected.get(id(4))!.expiresAt!;
    assert.equal(first.candidates[0]!.expiresAt, expiresAt);
    setClock(Date.parse(expiresAt) - 1);
    const again = await b.handoff.resolveNearby({ selectionToken: token });
    assert.equal(again.candidates[0]!.expiresAt, expiresAt);
    setClock(Date.parse(expiresAt));
    assert.equal((await b.handoff.resolveNearby({ selectionToken: token })).error!.code, "observation_expired");
    assert.equal((await a.handoff.getFlight({ target: { kind: "choice", candidateToken: first.candidates[0]!.candidateToken } })).error!.code, "choice_expired");
  });
});

test("worker-independent explicit lookup preserves its exact date and route; fake failures stay closed", async () => {
  await workers(async ({ a, b }) => {
    const selected = await board(a);
    for (const [index, code] of [[2, "identity_unconfirmed"], [5, "identity_changed"], [6, "backend_unavailable"]] as const)
      assert.equal((await b.handoff.resolveNearby({ selectionToken: selected.get(id(index))!.token })).error!.code, code);
    assert.equal(selected.get(id(3))!.state, "unsupported");
    const lookup = await a.handoff.getFlight({ target: { kind: "lookup", query: "SYN101", date: "2026-10-05", originIata: "MDW", destinationIata: "DEN" } });
    const exact = await b.handoff.getFlight({ target: { kind: "instance", flightInstanceId: lookup.flightInstanceId } });
    assert.equal(exact.status, "resolved"); assert.equal(exact.flight!.identity.serviceDate, "2026-10-05");
    assert.equal(exact.flight!.route.origin.iata, "MDW"); assert.equal(exact.flight!.route.destination.iata, "DEN");
    assert.equal((await b.handoff.getFlight({ target: { kind: "lookup", query: "SYN101" } })).error!.code, "date_unavailable");
    assert.equal((await b.handoff.getFlight({ target: { kind: "lookup", query: "UA219", date: "today" } })).error!.code, "unsupported_query");
    assert.equal((await b.handoff.getFlight({ target: { kind: "instance", flightInstanceId: "00000000-0000-4000-8000-000000000000" } })).status, "not_found");
    for (const p of [a, b]) assert.deepEqual(p.handoff.diagnostics(), { ...p.handoff.diagnostics(), providerCalls: 0, productionApiCalls: 0, productionDbAccess: 0 });
  });
});
