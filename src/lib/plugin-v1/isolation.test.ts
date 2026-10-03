import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

test("Foundation and fixture proof import no provider, live story, DB runtime, or current web UI", () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const visited = new Set<string>();
  const visit = (path: string) => {
    if (visited.has(path)) return; visited.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/g)) {
      const name = match[1]!;
      assert.doesNotMatch(name, /adsb|fr24|flightstats|flight-data|story(?:\.server)?|metar|baggage|arrival.*server|db(?:\.ts)?$/i, path);
      if (name.startsWith(".")) visit(resolve(dirname(path), name.endsWith(".ts") ? name : `${name}.ts`));
    }
    assert.doesNotMatch(source, /\b(?:fetchAround|getFlightStory|loadFlightStory|createServerFn)\s*\(/, path);
  };
  for (const file of ["contracts.ts", "areas.ts", "geography.ts", "ranking.ts", "stability.ts", "fixtures.ts", "proof-server.ts", "proof-preview.ts", "proof-egress.ts"]) visit(resolve(directory, file));
  assert.ok(visited.size > 7);
});
