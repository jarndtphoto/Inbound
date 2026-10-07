import type { IncomingMessage, ServerResponse } from "node:http";
import { createFixtureProofHandler } from "./proof-server";

// This entry point is emitted only into the separate fixture deployment.
export const FIXTURE_PREVIEW_EXPIRES_AT = "2026-10-10T23:59:59.000Z";
const forbiddenConfiguration = /DATABASE|POSTGRES|PGHOST|PGPASSWORD|NEON|FR24|FLIGHTRADAR|FLIGHTSTATS|ADSB|ADS_B|FLIGHTAWARE|WEATHER|FAA|INBOUND.*(?:API|TOKEN|SECRET)/i;
const handlers = new Map<string, ReturnType<typeof createFixtureProofHandler>>();

export default async function fixturePreview(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Inbound-Fixture-Only", "true");
  res.setHeader("X-Inbound-Egress", "static-isolation");
  if (process.env.VERCEL_ENV !== "preview" || !process.env.VERCEL_URL ||
      !/^[a-z0-9-]+\.vercel\.app$/.test(process.env.VERCEL_URL) ||
      Object.keys(process.env).some(name => forbiddenConfiguration.test(name) && process.env[name]) ||
      Date.now() > Date.parse(FIXTURE_PREVIEW_EXPIRES_AT)) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Fixture preview is disabled outside its isolated preview environment or test window." }));
    return;
  }
  const host = process.env.VERCEL_URL;
  let proof = handlers.get(host);
  if (!proof) {
    proof = createFixtureProofHandler({ allowedHosts: [host], onRead: (method, toolCalls) => console.info(JSON.stringify({ fixtureOnly: true, method, toolCalls, egressPolicy: "static-isolation" })) });
    handlers.set(host, proof);
  }
  // Vercel may supply the rewritten function path instead of the public path.
  if (req.url === "/api/mcp") req.url = "/mcp";
  await proof.handler(req, res);
}
