import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeRadarProofService } from "./radar-proof-engine.server";
import { createPrivateInboundAirborneBackend } from "./live-airborne-backend.server";
import { LiveAirborneNearbyResponseSchema } from "./live-airborne-source.server";

const T0 = Date.parse("2026-10-05T13:00:06Z");

test("private Nearby engine serializes through the live boundary as airborne-only Radar", async () => {
  const service = await createFakeRadarProofService({ clock: () => T0 });
  try {
    const backend = createPrivateInboundAirborneBackend({ engine: service, clock: () => T0 });
    const response = await backend.nearby({ area: "preset:chicago" });
    assert.equal(LiveAirborneNearbyResponseSchema.safeParse(response).success, true);
    assert.ok(response.radarTargets.length > 0);
    assert.ok(response.radarTargets.every(target => ["climb", "cruise", "descent", "approach"].includes(target.motion.phase)));
    assert.ok(response.radarTargets.every(target => target.altitudeFt === null || target.altitudeFt >= 500));
    assert.ok(response.radarTargets.every(target => target.groundspeedKt === null || target.groundspeedKt >= 40));
    assert.ok(response.radarTargets.every(target => target.selection.state === "unsupported"));
    assert.equal(service.diagnostics().providerApiCalls, 0);
    assert.equal(service.diagnostics().productionApiCalls, 0);
    assert.equal(service.diagnostics().productionDbAccess, 0);
  } finally {
    service.dispose();
  }
});

test("Track flight fails closed until a real Inbound handoff is explicitly injected", async () => {
  const service = await createFakeRadarProofService({ clock: () => T0 });
  try {
    const backend = createPrivateInboundAirborneBackend({ engine: service, clock: () => T0 });
    const resolve = await backend.resolve({ selectionToken: "A".repeat(43) });
    const flight = await backend.getFlight({ target: { kind: "lookup", query: "UAL123", date: "2026-10-05" } });
    assert.equal(resolve.status, "unsupported");
    assert.equal(flight.status, "unsupported");
    assert.match(resolve.error?.message ?? "", /not enabled/);
  } finally {
    service.dispose();
  }
});
