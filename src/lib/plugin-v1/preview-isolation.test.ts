import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { assertFixtureApplication, assertFixturePayload } from "../../../scripts/plugin-v1-preview-isolation.mjs";

const directory = resolve("deploy/plugin-v1-fixture-preview");
test("Deployment is exactly three audited files byte-identical to the fixture build", async () => {
  const audit = await assertFixturePayload(directory);
  assert.deepEqual(audit.files, ["api/mcp.js", "package.json", "vercel.json"]);
  for (const path of audit.files) assert.deepEqual(await readFile(`${directory}/${path}`), await readFile(`artifacts/plugin-v1-fixture-preview/${path}`));
});
test("Negative safety fixtures reject outbound clients, forbidden modules, dynamic code, endpoints and credentials", async () => {
  const code = await readFile(`${directory}/api/mcp.js`, "utf8");
  for (const addition of [
    "fetch('https://provider.example');", "new WebSocket('wss://provider.example');", "globalThis['fetch']('/');",
    ...["undici", "axios", "got", "node:http", "node:https", "node:net", "node:tls", "node:dns", "node:dgram", "node:child_process", "pg", "postgres", "@neondatabase/serverless", "../src/lib/fr24.server", "../src/lib/db", "../src/lib/public-api.server"].map(name => `import client from '${name}';`),
    "import('undici');", "require('node:https');", "Function('return process')();", "process.getBuiltinModule('https');",
    "const endpoint='https://api.flightradar24.com';", "const db='postgres://user:password@database.example/db';", "const key='sk-proj-abcdefghijklmnopqrstuv';",
  ]) assert.throws(() => assertFixtureApplication(code + '\n' + addition), /Fixture static isolation/);
  const extra = await mkdtemp(`${tmpdir()}/fixture-isolation-`);
  try {
    await mkdir(`${extra}/api`);
    for (const path of ["api/mcp.js", "package.json", "vercel.json"]) await writeFile(`${extra}/${path}`, await readFile(`${directory}/${path}`));
    await writeFile(`${extra}/unexpected.txt`, "unapproved");
    await assert.rejects(assertFixturePayload(extra), /exactly the approved three files/);
  } finally { await rm(extra, { recursive: true }); }
});
test("Compiled fixture works through real HTTP/Undici without changing host globals or Node builtins", async () => {
  const watched: [object, string][] = [[globalThis, "fetch"], [globalThis, "WebSocket"], [http, "request"], [http, "get"], [https, "request"], [net, "connect"], [net.Socket.prototype, "connect"], [tls, "connect"], [dns, "lookup"], [dns.promises, "resolve"], [dgram, "createSocket"], [childProcess, "spawn"]];
  const descriptors = watched.map(([object, name]) => Object.getOwnPropertyDescriptor(object, name));
  const { default: handler } = await import(pathToFileURL(`${directory}/api/mcp.js`).href);
  watched.forEach(([object, name], i) => assert.deepEqual(Object.getOwnPropertyDescriptor(object, name), descriptors[i], name));
  assert.doesNotThrow(() => { globalThis.fetch = globalThis.fetch; http.request = http.request; });
  const previous = process.env;
  // Preserve host-owned localhost routing while stripping application config.
  // Node's environment proxy reads NO_PROXY per request in this workspace.
  const transportEnvironment = { NO_PROXY: previous.NO_PROXY, no_proxy: previous.no_proxy };
  const host = "inbound-live-fixture-local-test.vercel.app";
  process.env = { ...transportEnvironment, VERCEL_ENV: "preview", VERCEL_URL: host };
  const server = createServer((req, res) => { req.headers.host = host; void handler(req, res); });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/mcp`;
    const native = await fetch(endpoint, { headers: { Connection: "close" } }).catch(error => { throw new Error("Initial native loopback fetch failed", { cause: error }); }); assert.equal(native.status, 405, "native Undici loopback transport succeeds"); await native.text();
    const result = await promisify(childProcess.execFile)(process.execPath, ["scripts/plugin-v1-mcp-inspect.mjs", endpoint, "", "--local-proof"], { env: { PATH: previous.PATH } });
    const inspected = JSON.parse(result.stdout);
    assert.equal(inspected.status, "passed"); assert.equal(inspected.checks.length, 43);
    assert.deepEqual(inspected.toolReads.map((r: { areaId: string }) => r.areaId), ["preset:chicago", "airport:KORD", "airport:KMDW", "preset:chicago"]);
    for (const config of [{ VERCEL_ENV: "production", VERCEL_URL: host }, { VERCEL_ENV: "preview", VERCEL_URL: "bad.example" }, { VERCEL_ENV: "preview", VERCEL_URL: host, DATABASE_URL: "unshipped-test-secret" }]) {
      process.env = { ...transportEnvironment, ...config };
      const response = await fetch(endpoint, { headers: { Connection: "close" } }).catch(error => { throw new Error(`Refusal HTTP check failed: ${JSON.stringify(Object.keys(config))}`, { cause: error }); }); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("unshipped-test-secret"));
    }
    process.env = { ...transportEnvironment, VERCEL_ENV: "preview", VERCEL_URL: host };
    const originalNow = Date.now;
    let expiryStatus = 0;
    try {
      Date.now = () => Date.parse("2026-10-11T00:00:00Z");
      await handler({ url: "/mcp", method: "GET", headers: { host } }, { setHeader() {}, writeHead(status: number) { expiryStatus = status; }, end() {} });
      assert.equal(expiryStatus, 503);
    } finally { Date.now = originalNow; }
  } finally { process.env = previous; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
