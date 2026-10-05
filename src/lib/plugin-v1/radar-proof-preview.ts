import type { IncomingMessage, ServerResponse } from "node:http";
import { createRadarProofHandler } from "./radar-proof-server";

export const RADAR_PREVIEW_EXPIRES_AT = "2026-10-11T23:59:59.000Z";
const fixtureAuthority = "__RADAR_FIXTURE_HANDLE_AUTHORITY__";
const forbiddenConfiguration = /DATABASE|POSTGRES|PGHOST|PGPASSWORD|NEON|FR24|FLIGHTRADAR|FLIGHTSTATS|ADSB|ADS_B|AIRPLANES|FLIGHTAWARE|CIRIUM|INBOUND.*(?:API|TOKEN|SECRET)/i;
const handlers = new Map<string, Promise<Awaited<ReturnType<typeof createRadarProofHandler>>>>();

/** New fake-only Preview function. Never mounted in Inbound or the old fixture. */
export default async function radarPreview(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Inbound-Fixture-Only", "true");
  res.setHeader("X-Inbound-Egress", "static-isolation");
  if (process.env.VERCEL_ENV !== "preview" || !process.env.VERCEL_URL
    || !/^[a-z0-9-]+\.vercel\.app$/.test(process.env.VERCEL_URL)
    || Object.keys(process.env).some(name => forbiddenConfiguration.test(name) && process.env[name])
    || Date.now() > Date.parse(RADAR_PREVIEW_EXPIRES_AT)) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Radar preview is disabled outside its isolated Preview environment or test window." }));
    return;
  }
  const host = process.env.VERCEL_URL;
  let proof = handlers.get(host);
  if (!proof) { proof = createRadarProofHandler({ allowedHosts: [host], fixtureAuthority: { authority: fixtureAuthority, realm: host } }); handlers.set(host, proof); }
  // Rewrite preserves distinct /widget and /mcp public paths in req.url.
  if (req.url === "/api/mcp") req.url = "/mcp";
  await (await proof).handler(req, res);
}
