import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  FlightResultV1Schema, GetFlightRequestV1Schema, ResolveNearbyRequestV1Schema, serializedBytes,
} from "./contracts";
import {
  InboundNearbyResponseSchema, NearbyTransportRequestSchema, PUBLIC_NEARBY_PAYLOAD_BYTES,
} from "./nearby-response";
import type { InboundAirborneSource } from "./live-airborne-source.server";

export const LIVE_RADAR_TOOL = "get_nearby_flights";
export const LIVE_RESOLVE_TOOL = "resolve_nearby_flight";
export const LIVE_GET_FLIGHT_TOOL = "get_flight";
export const LIVE_RADAR_RESOURCE = "ui://inbound/live-airborne-radar-v1.html";
export const LIVE_RADAR_UI_MIME = "text/html;profile=mcp-app";
export const LIVE_RADAR_NOTICE = "Live airborne aircraft from Inbound. Ground aircraft are excluded from this preview.";

const protocols = ["2025-11-25", "2025-06-18", "2025-03-26"];
const inputSchema = z.toJSONSchema(NearbyTransportRequestSchema);
const outputSchema = z.toJSONSchema(InboundNearbyResponseSchema);
const resolveInputSchema = z.toJSONSchema(ResolveNearbyRequestV1Schema);
const getFlightInputSchema = z.toJSONSchema(GetFlightRequestV1Schema);
const flightOutputSchema = z.toJSONSchema(FlightResultV1Schema);
const rpcRequest = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number().int()]).optional(),
  method: z.string().min(1).max(80),
  params: z.record(z.string(), z.unknown()).optional(),
});
const template = () => readFileSync(new URL("../../../docs/plugin-v1/radar-proof/widget.html", import.meta.url), "utf8");
const widgetScript = () => readFileSync(new URL("../../../artifacts/plugin-v1-radar-widget.js", import.meta.url), "utf8");
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function allowed(req: IncomingMessage, hosts: readonly string[] = []) {
  let authority: URL;
  try { authority = new URL(`http://${req.headers.host}`); } catch { return false; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname);
  if (!local && !hosts.includes(authority.host)) return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin).origin;
    return origin === authority.origin || !local && (origin === `https://${authority.host}` || origin === "https://chatgpt.com");
  } catch { return false; }
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "X-Inbound-Live-Plugin": "airborne-v1",
    "X-Inbound-Egress": "inbound-source-only",
  });
  res.end(JSON.stringify(body));
}

export function createLiveRadarHandler(options: {
  source: InboundAirborneSource;
  allowedHosts?: readonly string[];
}) {
  const stats = { requests: 0, toolCalls: 0, resourceReads: 0, sourceCalls: 0, aviationProviderCalls: 0 };
  async function nearby(input: unknown) {
    stats.sourceCalls++;
    return options.source.nearby(NearbyTransportRequestSchema.parse(input));
  }
  async function html(nonce = randomBytes(18).toString("base64url")) {
    const initial = await nearby({ area: "preset:chicago" });
    return template().replaceAll("__PROOF_NONCE__", nonce)
      .replace("__INITIAL_NEARBY__", () => JSON.stringify(initial).replaceAll("<", "\\u003c"))
      .replace("__RADAR_WIDGET_JS__", () => widgetScript().replaceAll("</script", "<\\/script"));
  }

  return {
    stats,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      stats.requests++;
      try {
        if (!allowed(req, options.allowedHosts)) { send(res, 403, { error: "Unknown Inbound Live authority or origin." }); return; }
        if (req.url === "/" || req.url === "/widget") {
          if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return; }
          const nonce = randomBytes(18).toString("base64url");
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff", "X-Inbound-Live-Plugin": "airborne-v1",
            "X-Inbound-Egress": "inbound-source-only",
            "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'`,
          });
          res.end(await html(nonce)); return;
        }
        if (req.url !== "/mcp") { send(res, 404, { error: "Unknown Inbound Live path." }); return; }
        if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
        if (!req.headers["content-type"]?.startsWith("application/json")) { send(res, 415, { error: "Expected JSON." }); return; }
        const accept = req.headers.accept ?? "";
        if (!accept.includes("application/json") || !accept.includes("text/event-stream")) { send(res, 406, { error: "Expected MCP Accept types." }); return; }
        const protocol = req.headers["mcp-protocol-version"];
        if (typeof protocol === "string" && !protocols.includes(protocol)) { send(res, 400, { error: "Unsupported MCP protocol version." }); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of req) {
          const value = Buffer.from(chunk); bytes += value.byteLength;
          if (bytes > 8192) { send(res, 413, { error: "Inbound Live request is too large." }); return; }
          chunks.push(value);
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { send(res, 200, rpcError(null, -32700, "Invalid JSON.")); return; }
        const parsed = rpcRequest.safeParse(body);
        if (!parsed.success) { send(res, 200, rpcError(null, -32600, "Invalid JSON-RPC request.")); return; }
        const { id, method, params = {} } = parsed.data;
        if (id === undefined) { res.writeHead(202); res.end(); return; }
        let result: unknown;
        switch (method) {
          case "initialize":
            result = {
              protocolVersion: typeof params.protocolVersion === "string" && protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0],
              capabilities: { tools: {}, resources: {} }, serverInfo: { name: "inbound-live-airborne", version: "0.5.0" },
              instructions: LIVE_RADAR_NOTICE,
            }; break;
          case "ping": result = {}; break;
          case "tools/list":
            result = { tools: [
              { name: LIVE_RADAR_TOOL, title: "Inbound Live Radar", description: "Show live airborne Nearby aircraft from Inbound for Chicago, ORD or MDW. Ground aircraft are excluded in this stage.", inputSchema, outputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: LIVE_RADAR_RESOURCE, visibility: ["model", "app"] }, "openai/outputTemplate": LIVE_RADAR_RESOURCE, "openai/widgetAccessible": true } },
              { name: LIVE_RESOLVE_TOOL, title: "Resolve selected airborne flight", description: "Resolve one opaque Inbound airborne selection. Ground occurrences fail closed.", inputSchema: resolveInputSchema, outputSchema: flightOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: LIVE_RADAR_RESOURCE, visibility: ["model", "app"] }, "openai/outputTemplate": LIVE_RADAR_RESOURCE, "openai/widgetAccessible": true } },
              { name: LIVE_GET_FLIGHT_TOOL, title: "Get airborne flight detail", description: "Read an airborne flight through the Inbound live source. Ground detail is outside this preview.", inputSchema: getFlightInputSchema, outputSchema: flightOutputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: LIVE_RADAR_RESOURCE, visibility: ["model", "app"] }, "openai/outputTemplate": LIVE_RADAR_RESOURCE, "openai/widgetAccessible": true } },
            ] }; break;
          case "tools/call": {
            let structuredContent: unknown;
            if (params.name === LIVE_RADAR_TOOL && NearbyTransportRequestSchema.safeParse(params.arguments).success) structuredContent = await nearby(params.arguments);
            else if (params.name === LIVE_RESOLVE_TOOL && ResolveNearbyRequestV1Schema.safeParse(params.arguments).success) {
              stats.sourceCalls++; structuredContent = await options.source.resolve(params.arguments as never);
            } else if (params.name === LIVE_GET_FLIGHT_TOOL && GetFlightRequestV1Schema.safeParse(params.arguments).success) {
              stats.sourceCalls++; structuredContent = await options.source.getFlight(params.arguments as never);
            } else { send(res, 200, rpcError(id, -32602, "Unsupported read-only tool or request.")); return; }
            stats.toolCalls++;
            if (serializedBytes(structuredContent) > PUBLIC_NEARBY_PAYLOAD_BYTES) {
              send(res, 200, rpcError(id, -32603, "Tool response exceeds its safe transport envelope.")); return;
            }
            result = {
              content: [{ type: "text", text: LIVE_RADAR_NOTICE }], structuredContent,
              _meta: { liveAirborneOnly: true, source: "Inbound", refreshIntervalSeconds: 20 },
            };
            break;
          }
          case "resources/list":
            result = { resources: [{ uri: LIVE_RADAR_RESOURCE, name: "Inbound Live airborne Radar", mimeType: LIVE_RADAR_UI_MIME, description: LIVE_RADAR_NOTICE }] }; break;
          case "resources/read":
            if (params.uri !== LIVE_RADAR_RESOURCE) { send(res, 200, rpcError(id, -32602, "Unknown Radar resource.")); return; }
            stats.resourceReads++;
            result = { contents: [{ uri: LIVE_RADAR_RESOURCE, mimeType: LIVE_RADAR_UI_MIME, text: await html(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] }, "openai/widgetDescription": LIVE_RADAR_NOTICE } }] }; break;
          default: send(res, 200, rpcError(id, -32601, "Unknown Inbound Live method.")); return;
        }
        send(res, 200, { jsonrpc: "2.0", id, result });
      } catch {
        if (!res.headersSent) send(res, 503, { error: "Inbound Live airborne source is temporarily unavailable." });
        else res.end();
      }
    },
  };
}

export function createLiveRadarServer(options: Parameters<typeof createLiveRadarHandler>[0]) {
  const live = createLiveRadarHandler(options);
  return { ...live, server: createServer(live.handler) };
}
