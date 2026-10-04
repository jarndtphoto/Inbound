import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { areaDefinition } from "./areas";
import { createFakeRadarProofService } from "./radar-proof-engine.server";
import { InboundNearbyResponseSchema, NearbyTransportRequestSchema, PUBLIC_NEARBY_PAYLOAD_BYTES, serializeNearbyResponse } from "./nearby-response";

export const RADAR_PROOF_TOOL = "get_nearby_flights";
export const RADAR_PROOF_RESOURCE = "ui://inbound/radar-v1.html";
export const RADAR_UI_MIME = "text/html;profile=mcp-app";
export const RADAR_PROOF_NOTICE = "Invented aircraft only. This Radar transport preview is not live flight information.";
const protocols = ["2025-11-25", "2025-06-18", "2025-03-26"];
const inputSchema = z.toJSONSchema(NearbyTransportRequestSchema);
const outputSchema = z.toJSONSchema(InboundNearbyResponseSchema);
const rpcRequest = z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(128), z.number().int()]).optional(), method: z.string().min(1).max(80), params: z.record(z.string(), z.unknown()).optional() });
const template = () => readFileSync(new URL("../../../docs/plugin-v1/radar-proof/widget.html", import.meta.url), "utf8");
const widgetScript = () => readFileSync(new URL("../../../artifacts/plugin-v1-radar-widget.js", import.meta.url), "utf8");
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export type RadarProofOptions = { clock?: () => number; allowedHosts?: readonly string[] };
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
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}

/** Separate fake-data host proof. No provider choice, route inference or database
 * access lives in MCP: every result comes from the unchanged private engine. */
export async function createRadarProofHandler(options: RadarProofOptions = {}) {
  const clock = options.clock ?? Date.now;
  const service = await createFakeRadarProofService({ clock });
  const stats = { requests: 0, toolCalls: 0, resourceReads: 0, aviationProviderCalls: 0, productionApiCalls: 0, productionDbAccess: 0 };
  async function nearby(input: unknown) {
    const request = NearbyTransportRequestSchema.parse(input);
    const area = areaDefinition(request.area);
    if (request.radiusNm !== undefined) area.radiusNm = request.radiusNm;
    const result = await service.request(request.area, { radiusNm: request.radiusNm, limit: request.limit });
    return serializeNearbyResponse(result, area, clock());
  }
  async function html(nonce = randomBytes(18).toString("base64url")) {
    const initial = await nearby({ area: "preset:chicago" });
    return template().replaceAll("__PROOF_NONCE__", nonce)
      .replace("__INITIAL_NEARBY__", () => JSON.stringify(initial).replaceAll("<", "\\u003c"))
      .replace("__RADAR_WIDGET_JS__", () => widgetScript().replaceAll("</script", "<\\/script"));
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    stats.requests++;
    res.setHeader("X-Inbound-Fixture-Only", "true");
    res.setHeader("X-Inbound-Egress", "static-isolation");
    try {
      if (!allowed(req, options.allowedHosts)) { send(res, 403, { error: "Unknown Radar proof authority or origin." }); return; }
      if (req.url === "/" || req.url === "/widget") {
        if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }); res.end(); return; }
        const nonce = randomBytes(18).toString("base64url");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'` });
        res.end(await html(nonce)); return;
      }
      if (req.url !== "/mcp") { send(res, 404, { error: "Unknown Radar proof path." }); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
      if (!req.headers["content-type"]?.startsWith("application/json")) { send(res, 415, { error: "Expected JSON." }); return; }
      const accept = req.headers.accept ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) { send(res, 406, { error: "Expected MCP Accept types." }); return; }
      const protocol = req.headers["mcp-protocol-version"];
      if (typeof protocol === "string" && !protocols.includes(protocol)) { send(res, 400, { error: "Unsupported MCP protocol version." }); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); bytes += buffer.byteLength;
        if (bytes > 8192) { send(res, 413, { error: "Radar proof request is too large." }); return; }
        chunks.push(buffer);
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
        case "initialize": result = { protocolVersion: typeof params.protocolVersion === "string" && protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0], capabilities: { tools: {}, resources: {} }, serverInfo: { name: "inbound-fake-radar-proof", version: "0.3.0" }, instructions: RADAR_PROOF_NOTICE }; break;
        case "ping": result = {}; break;
        case "tools/list": result = { tools: [{ name: RADAR_PROOF_TOOL, title: "Inbound Live Radar preview", description: "Show invented Nearby aircraft for Chicago, ORD or MDW. Fake-data host proof only; never use as live flight information.", inputSchema, outputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: RADAR_PROOF_RESOURCE, visibility: ["model", "app"] }, "openai/outputTemplate": RADAR_PROOF_RESOURCE, "openai/widgetAccessible": true } }] }; break;
        case "tools/call": {
          if (params.name !== RADAR_PROOF_TOOL || !NearbyTransportRequestSchema.safeParse(params.arguments).success) { send(res, 200, rpcError(id, -32602, "Unsupported Nearby tool or request.")); return; }
          stats.toolCalls++;
          result = { content: [{ type: "text", text: RADAR_PROOF_NOTICE }], structuredContent: await nearby(params.arguments), _meta: { fakeAircraftOnly: true, refreshIntervalSeconds: 20 } };
          // The outer tool response also fits the public V1 envelope.
          if (Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8") > PUBLIC_NEARBY_PAYLOAD_BYTES) { send(res, 200, rpcError(id, -32603, "Nearby response exceeds its safe transport envelope.")); return; }
          break;
        }
        case "resources/list": result = { resources: [{ uri: RADAR_PROOF_RESOURCE, name: "Inbound Live Radar preview", mimeType: RADAR_UI_MIME, description: "Many invented aircraft through the certified Nearby engine." }] }; break;
        case "resources/read":
          if (params.uri !== RADAR_PROOF_RESOURCE) { send(res, 200, rpcError(id, -32602, "Unknown Radar resource.")); return; }
          stats.resourceReads++;
          result = { contents: [{ uri: RADAR_PROOF_RESOURCE, mimeType: RADAR_UI_MIME, text: await html(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] }, "openai/widgetDescription": RADAR_PROOF_NOTICE } }] }; break;
        default: send(res, 200, rpcError(id, -32601, "Unknown Radar proof method.")); return;
      }
      send(res, 200, { jsonrpc: "2.0", id, result });
    } catch { if (!res.headersSent) send(res, 500, { error: "Radar proof is temporarily unavailable." }); else res.end(); }
  };
  return { handler, stats, service, dispose: service.dispose };
}

export async function createRadarProofServer(options: RadarProofOptions = {}) {
  const proof = await createRadarProofHandler(options);
  return { ...proof, server: createServer(proof.handler) };
}
