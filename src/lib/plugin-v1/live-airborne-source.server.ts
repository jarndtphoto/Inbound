import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  FlightResultV1Schema, GetFlightRequestV1Schema, ResolveNearbyRequestV1Schema,
  type FlightResultV1, type GetFlightRequestV1, type ResolveNearbyRequestV1,
} from "./contracts";
import {
  InboundNearbyResponseSchema, NearbyTransportRequestSchema,
  type InboundNearbyResponse, type NearbyTransportRequest,
} from "./nearby-response";

export const INBOUND_AIRBORNE_SOURCE_HEADER = "airborne-v1";
const AIRBORNE_MOTION = new Set(["climb", "cruise", "descent", "approach"]);
const GROUND_STAGES = new Set(["origin_gate", "push", "taxi", "taxi_in", "gate", "Takeoff roll"]);
const BLOCKED_PROVIDER_DOMAINS = [
  "adsb.fi", "adsb.lol", "airplanes.live", "flightradar24.com",
  "flightaware.com", "flightstats.com", "cirium.com",
];

export const LiveAirborneNearbyResponseSchema = InboundNearbyResponseSchema.superRefine((response, context) => {
  for (const [index, target] of response.radarTargets.entries()) {
    if (!AIRBORNE_MOTION.has(target.motion.phase)) context.addIssue({
      code: "custom", path: ["radarTargets", index, "motion", "phase"],
      message: "Live airborne source cannot publish ground motion",
    });
  }
  for (const [index, flight] of response.featuredFlights.entries()) {
    if (!AIRBORNE_MOTION.has(flight.motion.phase)) context.addIssue({
      code: "custom", path: ["featuredFlights", index, "motion", "phase"],
      message: "Live airborne source cannot publish ground motion",
    });
  }
});

export const LiveAirborneFlightResultSchema = FlightResultV1Schema.superRefine((result, context) => {
  if (result.status !== "resolved" || !result.flight) return;
  const flight = result.flight;
  if (!flight.position || flight.position.onGround !== false) context.addIssue({
    code: "custom", path: ["flight", "position"], message: "Live airborne detail requires an airborne position",
  });
  if (flight.phase.motion && !AIRBORNE_MOTION.has(flight.phase.motion)) context.addIssue({
    code: "custom", path: ["flight", "phase", "motion"], message: "Ground motion is outside the live airborne stage",
  });
  if (flight.phase.stage && GROUND_STAGES.has(flight.phase.stage)) context.addIssue({
    code: "custom", path: ["flight", "phase", "stage"], message: "Ground stage is outside the live airborne stage",
  });
  if (flight.phase.arrivalState?.value && flight.phase.arrivalState.value !== "airborne") context.addIssue({
    code: "custom", path: ["flight", "phase", "arrivalState"], message: "Ground arrival state is outside the live airborne stage",
  });
});

export type LiveAirborneNearbyResponse = z.infer<typeof LiveAirborneNearbyResponseSchema>;
export type LiveAirborneFlightResult = z.infer<typeof LiveAirborneFlightResultSchema>;

export type InboundAirborneSourceBackend = {
  nearby(input: NearbyTransportRequest): Promise<InboundNearbyResponse>;
  resolve(input: ResolveNearbyRequestV1): Promise<FlightResultV1>;
  getFlight(input: GetFlightRequestV1): Promise<FlightResultV1>;
};

export type InboundAirborneSource = {
  nearby(input: NearbyTransportRequest): Promise<LiveAirborneNearbyResponse>;
  resolve(input: ResolveNearbyRequestV1): Promise<LiveAirborneFlightResult>;
  getFlight(input: GetFlightRequestV1): Promise<LiveAirborneFlightResult>;
};

function sourceHeaders() {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Inbound-Live-Source": INBOUND_AIRBORNE_SOURCE_HEADER,
  };
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, sourceHeaders());
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.from(chunk); bytes += value.byteLength;
    if (bytes > 8192) throw new RangeError("Inbound live source request is too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Inbound-owned transport boundary. The backend is injected so this module
 * cannot select or call an aviation provider on its own. */
export function createInboundAirborneSourceHandler(backend: InboundAirborneSourceBackend) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") { res.writeHead(405, { ...sourceHeaders(), Allow: "POST" }); res.end(); return; }
    if (!req.headers["content-type"]?.startsWith("application/json")) { send(res, 415, { error: "Expected JSON." }); return; }
    try {
      const raw = await body(req);
      if (req.url === "/nearby") {
        const input = NearbyTransportRequestSchema.parse(raw);
        send(res, 200, LiveAirborneNearbyResponseSchema.parse(await backend.nearby(input))); return;
      }
      if (req.url === "/resolve") {
        const input = ResolveNearbyRequestV1Schema.parse(raw);
        send(res, 200, LiveAirborneFlightResultSchema.parse(await backend.resolve(input))); return;
      }
      if (req.url === "/flight") {
        const input = GetFlightRequestV1Schema.parse(raw);
        send(res, 200, LiveAirborneFlightResultSchema.parse(await backend.getFlight(input))); return;
      }
      send(res, 404, { error: "Unknown Inbound live source path." });
    } catch (error) {
      const badInput = error instanceof z.ZodError || error instanceof SyntaxError || error instanceof RangeError;
      send(res, badInput ? 400 : 503, { error: badInput ? "Invalid Inbound live source request or response." : "Inbound live source unavailable." });
    }
  };
}

export function createInboundAirborneSourceServer(backend: InboundAirborneSourceBackend) {
  return createServer(createInboundAirborneSourceHandler(backend));
}

function sourceOrigin(raw: string) {
  const value = new URL(raw);
  if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash
    || (value.pathname !== "/" && value.pathname !== "")) throw new RangeError("Inbound live source must be one HTTPS origin");
  const host = value.hostname.toLowerCase();
  if (BLOCKED_PROVIDER_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    throw new RangeError("ChatGPT MCP cannot use an aviation-provider URL as its Inbound source");
  }
  return value.origin;
}

export function createInboundAirborneSourceClient(options: {
  baseUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): InboundAirborneSource {
  const origin = sourceOrigin(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  async function post<T>(path: "/nearby" | "/resolve" | "/flight", input: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await fetcher(`${origin}${path}`, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Inbound live source HTTP ${response.status}`);
    if (response.headers.get("x-inbound-live-source") !== INBOUND_AIRBORNE_SOURCE_HEADER) {
      throw new Error("Untrusted Inbound live source response");
    }
    if (!response.headers.get("cache-control")?.toLowerCase().includes("no-store")) {
      throw new Error("Inbound live source response must be no-store");
    }
    return schema.parse(await response.json());
  }
  return {
    nearby: input => post("/nearby", NearbyTransportRequestSchema.parse(input), LiveAirborneNearbyResponseSchema),
    resolve: input => post("/resolve", ResolveNearbyRequestV1Schema.parse(input), LiveAirborneFlightResultSchema),
    getFlight: input => post("/flight", GetFlightRequestV1Schema.parse(input), LiveAirborneFlightResultSchema),
  };
}
