import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { destPoint } from "../geo";
import { resolveNearbyRequest } from "./areas";
import { NearbyFlightsResponseV1Schema, NearbyRequestV1Schema } from "./contracts";
import { FIXTURE_NOTICE, FIXTURE_NOW, fixtureNearbyBoard } from "./fixtures";

export const PROOF_TOOL = "fixture_get_nearby_flights";
export const PROOF_RESOURCE = "ui://inbound/fixture-live-v1.html";
export const UI_MIME = "text/html;profile=mcp-app";
const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const inputSchema = z.toJSONSchema(NearbyRequestV1Schema);
const outputSchema = z.toJSONSchema(NearbyFlightsResponseV1Schema);
const requestSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([z.string().max(128), z.number().int()]).optional(), method: z.string().min(1).max(80), params: z.record(z.string(), z.unknown()).optional() });
const template = () => readFileSync(new URL("../../../docs/plugin-v1/proof/widget.html", import.meta.url), "utf8");

/** Static fixture service only. No clock-driven acquisition or real selection. */
export function proofFixtureResult(input: unknown) {
  const resolution = resolveNearbyRequest(input, FIXTURE_NOW);
  let board;
  if (!resolution.ok) board = resolution.response;
  else {
    board = fixtureNearbyBoard(resolution.area.id, Math.min(4, resolution.limit));
    board.resolvedArea = resolution.area;
    if (resolution.includePosition) for (const card of board.flights) {
      const p = destPoint({ lat: resolution.area.reference.latitude, lon: resolution.area.reference.longitude }, 90, card.proximity.distanceNm);
      card.position = { latitude: p.lat, longitude: p.lon, kind: "observed" };
    }
  }
  return { content: [{ type: "text" as const, text: "STATIC FIXTURE PROOF: invented aircraft data, no live provider requests." }], structuredContent: NearbyFlightsResponseV1Schema.parse(board), _meta: { fixtureOnly: true, fixtureNotice: FIXTURE_NOTICE } };
}
export function proofWidgetHtml(nonce = randomBytes(18).toString("base64url")) {
  return template().replaceAll("__PROOF_NONCE__", nonce).replace("__INITIAL_FIXTURE__", JSON.stringify(proofFixtureResult({ area: { kind: "preset", nameOrId: "chicago" } }).structuredContent).replaceAll("<", "\\u003c"));
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(body));
}
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
export type FixtureProofOptions = {
  /** Exact opt-in preview authorities. Local proof stays local-only by default. */
  allowedHosts?: readonly string[];
  onRead?: (method: string, toolCalls: number) => void;
};
function allowedRequest(req: IncomingMessage, options: FixtureProofOptions) {
  let authority: URL;
  try { authority = new URL(`http://${req.headers.host}`); } catch { return false; }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(authority.hostname);
  const preview = options.allowedHosts?.includes(authority.host) === true;
  if (!local && !preview) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { const parsed = new URL(origin); return parsed.origin === authority.origin || preview && (parsed.origin === `https://${authority.host}` || parsed.origin === "https://chatgpt.com"); } catch { return false; }
}

/** Isolated stateless JSON Streamable HTTP proof; never mounted in app routes. */
export function createFixtureProofHandler(options: FixtureProofOptions = {}) {
  const stats = { requests: 0, toolCalls: 0 };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    stats.requests++;
    try {
      if (!allowedRequest(req, options)) { send(res, 403, { error: "Unknown fixture proof authority or origin." }); return; }
      if (req.url === "/" || req.url === "/widget") {
        if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
        const nonce = randomBytes(18).toString("base64url");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'` });
        res.end(proofWidgetHtml(nonce)); return;
      }
      if (req.url !== "/mcp") { send(res, 404, { error: "Unknown fixture proof path." }); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
      if (!req.headers["content-type"]?.startsWith("application/json")) { send(res, 415, { error: "Expected JSON." }); return; }
      const accept = req.headers.accept ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) { send(res, 406, { error: "Expected MCP Accept types." }); return; }
      const protocol = req.headers["mcp-protocol-version"];
      if (typeof protocol === "string" && !versions.includes(protocol)) { send(res, 400, { error: "Unsupported MCP protocol version." }); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        const b = Buffer.from(chunk); bytes += b.byteLength;
        if (bytes > 8192) { send(res, 413, { error: "Fixture request is too large." }); return; }
        chunks.push(b);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(res, 200, rpcError(null, -32700, "Invalid JSON.")); return; }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) { send(res, 200, rpcError(null, -32600, "Invalid JSON-RPC request.")); return; }
      const { id, method, params = {} } = parsed.data;
      if (id === undefined) { res.writeHead(202); res.end(); return; }
      let result: unknown;
      switch (method) {
        case "initialize": result = { protocolVersion: typeof params.protocolVersion === "string" && versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: {}, resources: {} }, serverInfo: { name: "inbound-static-fixture-proof", version: "0.1.0" }, instructions: FIXTURE_NOTICE }; break;
        case "ping": result = {}; break;
        case "tools/list": result = { tools: [{ name: PROOF_TOOL, title: "Inbound Live static fixture proof", description: "Render invented Chicago/ORD/MDW aircraft. Test fixtures only; never use as live flight information.", inputSchema, outputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: { ui: { resourceUri: PROOF_RESOURCE, visibility: ["model", "app"] }, "openai/outputTemplate": PROOF_RESOURCE, "openai/widgetAccessible": true } }] }; break;
        case "tools/call": {
          if (params.name !== PROOF_TOOL) { send(res, 200, rpcError(id, -32602, "Unknown fixture tool.")); return; }
          stats.toolCalls++;
          const fixture = proofFixtureResult(params.arguments);
          result = { ...fixture, _meta: { ...fixture._meta, fixtureReadId: randomBytes(9).toString("hex"), fixtureReadSequence: stats.toolCalls } }; break;
        }
        case "resources/list": result = { resources: [{ uri: PROOF_RESOURCE, name: "Inbound Live fixture board", mimeType: UI_MIME, description: "Static four-card aviation host proof." }] }; break;
        case "resources/read":
          if (params.uri !== PROOF_RESOURCE) { send(res, 200, rpcError(id, -32602, "Unknown fixture resource.")); return; }
          result = { contents: [{ uri: PROOF_RESOURCE, mimeType: UI_MIME, text: proofWidgetHtml(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/ui": { availableDisplayModes: ["inline", "pip", "fullscreen"] }, "openai/widgetDescription": "Invented static Inbound Live proof; not live flight information." } }] }; break;
        default: send(res, 200, rpcError(id, -32601, "Unknown fixture method.")); return;
      }
      options.onRead?.(method, stats.toolCalls);
      send(res, 200, { jsonrpc: "2.0", id, result });
    } catch { if (!res.headersSent) send(res, 500, { error: "Fixture proof unavailable." }); else res.end(); }
  };
  return { handler, stats };
}
export function createFixtureProofServer() {
  const { handler, stats } = createFixtureProofHandler();
  return { server: createServer(handler), stats };
}
