import type { FlightResultV1, GetFlightRequestV1, ResolveNearbyRequestV1 } from "./contracts";
import { FlightResultV1Schema } from "./contracts";
import { areaDefinition, type AREA_IDS } from "./areas";
import type { PrivateNearbyResponse } from "./nearby-response";
import { serializeNearbyResponse, type NearbyTransportRequest } from "./nearby-response";
import type { InboundAirborneSourceBackend } from "./live-airborne-source.server";
import type { SelectionByRadarId } from "./handoff-service.server";

type AreaId = (typeof AREA_IDS)[number];
export type PrivateAirborneNearbyEngine = {
  request(areaId: AreaId, input?: { radiusNm?: 12 | 25 | 38; limit?: number }): Promise<PrivateNearbyResponse>;
};
export type PrivateAirborneHandoff = {
  issueSelections(result: PrivateNearbyResponse): Promise<SelectionByRadarId>;
  resolveNearby(input: ResolveNearbyRequestV1): Promise<FlightResultV1>;
  getFlight(input: GetFlightRequestV1): Promise<FlightResultV1>;
};

function unavailable(nowMs: number): FlightResultV1 {
  return FlightResultV1Schema.parse({
    schemaVersion: "1.0", status: "unsupported", responseAt: new Date(nowMs).toISOString(),
    refreshAfterSeconds: null, flightInstanceId: null, flight: null, candidates: [],
    error: { code: "unsupported_aircraft", message: "Live Track flight is not enabled for this airborne-only source." },
  });
}

/** Thin adapter from the private Inbound Nearby engine to the source boundary.
 * It performs no acquisition or provider choice itself. Without an explicitly
 * injected real handoff, every Radar row remains local/unsupported for detail. */
export function createPrivateInboundAirborneBackend(options: {
  engine: PrivateAirborneNearbyEngine;
  handoff?: PrivateAirborneHandoff;
  clock?: () => number;
}): InboundAirborneSourceBackend {
  const clock = options.clock ?? Date.now;
  return {
    async nearby(input: NearbyTransportRequest) {
      const area = areaDefinition(input.area);
      if (input.radiusNm !== undefined) area.radiusNm = input.radiusNm;
      const result = await options.engine.request(input.area, { radiusNm: input.radiusNm, limit: input.limit });
      const selections = options.handoff ? await options.handoff.issueSelections(result) : new Map();
      return serializeNearbyResponse(result, area, clock(), selections);
    },
    async resolve(input) {
      return options.handoff ? options.handoff.resolveNearby(input) : unavailable(clock());
    },
    async getFlight(input) {
      return options.handoff ? options.handoff.getFlight(input) : unavailable(clock());
    },
  };
}
