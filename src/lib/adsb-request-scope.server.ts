import { AsyncLocalStorage } from "node:async_hooks";
import type { AdsbAcquisition } from "./adsb-acquisition.server.ts";

const requests = new AsyncLocalStorage<Map<string, Promise<AdsbAcquisition>>>();

/** Reuse a build's endpoint result even after its short shared cache expires.
 * Empty/busy outcomes and original observation timestamps stay unchanged;
 * subsequent independent requests get a new scope. */
export function withAdsbRequestScope<T>(run: () => Promise<T>): Promise<T> {
  return requests.run(new Map(), run);
}

export function reuseAdsbRequest(key: string, acquire: () => Promise<AdsbAcquisition>): Promise<AdsbAcquisition> {
  const scope = requests.getStore();
  if (!scope) return acquire();
  const existing = scope.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(acquire);
  scope.set(key, pending);
  return pending;
}
