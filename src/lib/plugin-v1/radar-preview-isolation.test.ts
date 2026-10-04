import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { installTestClock } from "../../../scripts/test-clock.mjs";
import {
  assertRadarApplication, assertRadarPayload,
  RADAR_PREVIEW_PACKAGE, RADAR_PREVIEW_CONFIG,
} from "../../../scripts/plugin-v1-radar-isolation.mjs";

const directory = resolve("deploy/plugin-v1-radar-preview");
const safeCode = "import { randomUUID, randomBytes as nonce } from 'node:crypto'; export default async function proof() { return { id: randomUUID(), nonce: nonce(18).toString('base64url') }; }";

async function isolatedPayload(run: (path: string) => Promise<void>) {
  const temporary = await mkdtemp(`${tmpdir()}/radar-isolation-`);
  try {
    await mkdir(`${temporary}/api`);
    await writeFile(`${temporary}/api/mcp.js`, safeCode);
    await writeFile(`${temporary}/package.json`, JSON.stringify(RADAR_PREVIEW_PACKAGE));
    await writeFile(`${temporary}/vercel.json`, JSON.stringify(RADAR_PREVIEW_CONFIG));
    await run(temporary);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("Radar proof deploys exactly three audited files byte-identical to its separate build", async () => {
  const audit = await assertRadarPayload(directory);
  assert.deepEqual(audit.files, ["api/mcp.js", "package.json", "vercel.json"]);
  assert.equal(audit.fakeAircraftOnly, true);
  for (const path of audit.files) {
    assert.deepEqual(await readFile(`${directory}/${path}`), await readFile(`artifacts/plugin-v1-radar-preview/${path}`));
  }
  assert.notDeepEqual(await readFile(`${directory}/api/mcp.js`), await readFile("deploy/plugin-v1-fixture-preview/api/mcp.js"));
  // The application Preview inherits a production-capable DATABASE_URL. This
  // proof branch must deploy only through the separately audited fake project;
  // preserve the existing foundation guard without changing global settings.
  assert.deepEqual(JSON.parse(await readFile("vercel.json", "utf8")), {
    $schema: "https://openapi.vercel.sh/vercel.json",
    git: { deploymentEnabled: { "plugin-v1-foundation": false, "plugin-v1-radar-transport": false } },
  });
});

test("Radar isolation rejects server egress, provider/production URLs, credentials and dynamic capabilities", () => {
  assert.doesNotThrow(() => assertRadarApplication(safeCode));
  for (const addition of [
    "fetch('/mcp');", "fetch('https://example.invalid');", "new WebSocket('wss://example.invalid');",
    "new XMLHttpRequest();", "new EventSource('/events');", "navigator.sendBeacon('/events');",
    "globalThis['fetch']('/');", "window['f' + 'etch']('/');", "const f = window['fetch']; f('/');",
    ...["undici", "axios", "got", "node:http", "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "node:child_process", "node:fs", "pg", "postgres", "@neondatabase/serverless", "@electric-sql/pglite", "../adsb-fusion", "../db", "../public-api.server"].map(name => `import client from '${name}';`),
    "import { webcrypto } from 'node:crypto';", "import * as crypto from 'node:crypto';",
    "export { default } from 'node:https';", "import('undici');", "require('node:https');",
    "Function('return process')();", "eval('process.env');", "process.getBuiltinModule('https');",
    "[].filter['con'+'structor']('return process')();",
    "const f = [].filter.constructor; f('return process')();",
    "let f; f = [].filter.constructor; f('return process')();",
    "Reflect.get(window, 'f'+'etch')('/mcp');",
    "const f = Object.getOwnPropertyDescriptor(window, 'fetch').value; f('/mcp');",
    "const nested = [].filter['constructor']['constructor'];",
    "const endpoint='https://api.flightradar24.com';", "const endpoint='api.adsb.fi';",
    "const endpoint='https://api.adsb.lol';", "const endpoint='api.airplanes.live';",
    "const endpoint='https://api.adsbdb.com';", "const endpoint='https://api.flightaware.com';",
    "const endpoint='https://flightstats.com';", "const endpoint='https://cirium.com';",
    "const endpoint='https://inbound.vercel.app/api/flight';",
    "const db='postgres://user:password@database.example/db';",
    "const db='postgresql://user:password@database.example/db';",
    "const key='sk-proj-abcdefghijklmnopqrstuv';", "const key='github_pat_abcdefghijklmnopqrstuv';",
    "const FR24_API_KEY='opaque-unshipped-value';", "const configuration={PGPASSWORD:'opaque-unshipped-value'};",
    "const configuration={'FLIGHTSTATS_APP_KEY':'opaque-unshipped-value'};",
    "const authorization='Bearer abcdefghijklmnopqrstuv';", "const key='-----BEGIN PRIVATE KEY';",
  ]) assert.throws(() => assertRadarApplication(`${safeCode}\n${addition}`), /Radar proof static isolation/, addition);
});

test("Widget isolation permits only its literal same-origin MCP fallback and self-contained resources", () => {
  assert.doesNotThrow(() => assertRadarApplication("fetch('/mcp', {method:'POST', body:'{}'});", { widget: true }));
  assert.doesNotThrow(() => assertRadarApplication("fetch(`/mcp`, {method:'POST'});", { widget: true }));
  assert.doesNotThrow(() => assertRadarApplication("document.createElementNS('http://www.w3.org/2000/svg', 'path');", { widget: true }));
  assert.doesNotThrow(() => assertRadarApplication("const html='<script>fetch(\"/mcp\");</script>';"));
  const embeddedIife = '(function(){const host="::1";new URL(`http://[${host}]`);fetch("/mcp");})();';
  assert.doesNotThrow(() => assertRadarApplication(`const widgetScript=()=>${JSON.stringify(embeddedIife)};`));
  assert.throws(() => assertRadarApplication(`const widgetScript=()=>${JSON.stringify('(function(){fetch("https://example.invalid");})();')};`), /Radar proof static isolation/);
  for (const code of [
    "fetch('/api/flight');", "const endpoint='/mcp'; fetch(endpoint);", "fetch('https://example.invalid/mcp');",
    "fetch('//example.invalid/mcp');", "window['fetch']('/mcp');", "import { randomUUID } from 'node:crypto';",
    "fetch('http://www.w3.org/2000/svg');",
  ]) assert.throws(() => assertRadarApplication(code, { widget: true }), /Radar proof static isolation/);
  for (const html of [
    '<script src="/external.js"></script>', '<script src="https://example.invalid/widget.js"></script>',
    '<img src="//example.invalid/radar.png">', '<link href="https://example.invalid/style.css">',
    '<style>.x{background:url(//example.invalid/radar.png)}</style>',
    '<script>fetch("/api/flight");</script>',
  ]) assert.throws(() => assertRadarApplication(`const html=${JSON.stringify(html)};`), /Radar proof static isolation/);
});

test("Deployment allowlist refuses extra files, directories, symlinks and altered application configuration", async () => {
  await isolatedPayload(async path => { await assertRadarPayload(path); });
  for (const filename of ["unexpected.txt", "audit.json", ".env", "api/provider.js"]) {
    await isolatedPayload(async path => {
      await writeFile(`${path}/${filename}`, "unapproved");
      await assert.rejects(assertRadarPayload(path), /exactly the approved three files/);
    });
  }
  await isolatedPayload(async path => {
    await mkdir(`${path}/node_modules`);
    await assert.rejects(assertRadarPayload(path), /unapproved deployment directory/);
  });
  await isolatedPayload(async path => {
    await symlink(`${path}/api/mcp.js`, `${path}/alias.js`);
    await assert.rejects(assertRadarPayload(path), /nonregular deployment entry/);
  });
  for (const [filename, content] of [
    ["package.json", { ...RADAR_PREVIEW_PACKAGE, dependencies: { pg: "*" } }],
    ["vercel.json", { ...RADAR_PREVIEW_CONFIG, env: { DATABASE_URL: "not-a-real-secret" } }],
    ["vercel.json", { ...RADAR_PREVIEW_CONFIG, rewrites: [{ source: "/mcp", destination: "https://example.invalid/mcp" }] }],
  ] as const) {
    await isolatedPayload(async path => {
      await writeFile(`${path}/${filename}`, JSON.stringify(content));
      await assert.rejects(assertRadarPayload(path), /unexpected (?:package|deployment) configuration/);
    });
  }
});

test("Compiled Radar import preserves writable host transport and refuses production, secrets and an expired proof window", async () => {
  const watched: [object, string][] = [
    [globalThis, "fetch"], [globalThis, "WebSocket"], [http, "request"], [http, "get"], [https, "request"],
    [net, "connect"], [net.Socket.prototype, "connect"], [tls, "connect"], [dns, "lookup"],
    [dns.promises, "resolve"], [dgram, "createSocket"], [childProcess, "spawn"],
  ];
  const descriptors = watched.map(([object, name]) => Object.getOwnPropertyDescriptor(object, name));
  const { default: handler } = await import(pathToFileURL(`${directory}/api/mcp.js`).href);
  watched.forEach(([object, name], index) => assert.deepEqual(Object.getOwnPropertyDescriptor(object, name), descriptors[index], name));
  const previous = process.env;
  const host = "inbound-live-radar-isolation-test.vercel.app";
  async function read() {
    const request = Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })]) as unknown as IncomingMessage;
    request.url = "/mcp"; request.method = "POST";
    request.headers = { host, "content-type": "application/json", accept: "application/json, text/event-stream" };
    let status = 200, body = "";
    const response = { setHeader() {}, writeHead(value: number) { status = value; }, end(value = "") { body = value; } } as unknown as ServerResponse;
    await handler(request, response);
    return { status, body };
  }
  const restoreClock = installTestClock(Date.parse("2026-10-04T03:00:00Z"));
  try {
    process.env = { VERCEL_ENV: "preview", VERCEL_URL: host };
    assert.equal((await read()).status, 200);
    for (const key of [
      "DATABASE_URL", "NEARBY_VERIFY_DATABASE_URL", "POSTGRES_URL", "PGHOST", "PGPASSWORD", "NEON_DATABASE_URL",
      "FR24_API_KEY", "FLIGHTRADAR24_TOKEN", "FLIGHTSTATS_APP_KEY", "CIRIUM_API_KEY", "ADSBDB_URL", "ADSB_API_KEY",
      "FLIGHTAWARE_API_KEY", "AIRPLANES_API_KEY", "INBOUND_API_SECRET",
    ]) {
      process.env = { VERCEL_ENV: "preview", VERCEL_URL: host, [key]: "unshipped-test-secret" };
      const result = await read();
      assert.equal(result.status, 503, key); assert.ok(!result.body.includes("unshipped-test-secret"), key);
    }
    process.env = { VERCEL_ENV: "production", VERCEL_URL: host };
    assert.equal((await read()).status, 503);
    process.env = { VERCEL_ENV: "preview", VERCEL_URL: "production.example.invalid" };
    assert.equal((await read()).status, 503);
    process.env = { VERCEL_ENV: "preview", VERCEL_URL: host };
    restoreClock();
    const restoreExpiredClock = installTestClock(Date.parse("2030-01-01T00:00:00Z"));
    try { assert.equal((await read()).status, 503); } finally { restoreExpiredClock(); }
  } finally { restoreClock(); process.env = previous; }
});
