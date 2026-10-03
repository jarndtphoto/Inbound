import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

/** Fixture preview process only. Never imported by the Inbound application. */
export function installFixtureEgressGuard() {
  let blocked = 0;
  const deny = () => {
    blocked++;
    console.warn("Inbound fixture blocked an outbound operation.");
    throw new Error("Outbound operations are disabled in the fixture proof.");
  };
  const replace = (object: object, names: string[]) => {
    for (const name of names) Object.defineProperty(object, name, { value: deny, configurable: false, writable: false });
  };
  Object.defineProperty(globalThis, "fetch", { value: async () => deny(), configurable: false, writable: false });
  if ("WebSocket" in globalThis) Object.defineProperty(globalThis, "WebSocket", { value: deny, configurable: false, writable: false });
  replace(http, ["request", "get"]);
  replace(https, ["request", "get"]);
  replace(net, ["connect", "createConnection"]);
  replace(net.Socket.prototype, ["connect"]);
  replace(tls, ["connect"]);
  replace(dgram, ["createSocket"]);
  replace(dns, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "reverse"]);
  replace(dns.promises, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "reverse"]);
  replace(childProcess, ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
  syncBuiltinESMExports();
  return { get blockedAttempts() { return blocked; } };
}
