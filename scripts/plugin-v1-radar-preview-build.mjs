import { rolldown } from 'rolldown';
import { readFile, mkdir, writeFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertRadarApplication, assertRadarPayload, RADAR_PREVIEW_PACKAGE, RADAR_PREVIEW_CONFIG } from './plugin-v1-radar-isolation.mjs';

const shared = [
  'src/lib/plugin-v1/nearby-response.ts', 'src/lib/plugin-v1/contracts.ts',
  'src/lib/plugin-v1/areas.ts', 'src/lib/plugin-v1/geography.ts',
  'src/lib/plugin-v1/ranking.ts', 'src/lib/plugin-v1/stability.ts',
  'src/lib/nearby-v1/model.ts', 'src/lib/nearby-v1/motion.ts',
  'src/lib/geo.ts', 'src/lib/airports.ts', 'src/lib/aircraft.ts',
  'src/lib/aircraft-phase.ts', 'src/lib/flight-parse.ts',
];
const permitted = new Set([...shared,
  'src/lib/plugin-v1/radar-proof-preview.ts', 'src/lib/plugin-v1/radar-proof-server.ts',
  'src/lib/plugin-v1/radar-proof-engine.server.ts', 'src/lib/plugin-v1/radar-proof-store.ts',
  'src/lib/plugin-v1/radar-widget.ts', 'src/lib/plugin-v1/radar-renderer.ts',
  'src/lib/nearby-v1/engine.server.ts', 'src/lib/nearby-v1/collection.ts',
  'src/lib/nearby-v1/views.ts', 'src/lib/nearby-v1/route-enrichment.ts', 'src/lib/nearby-v1/route-hints.ts',
].map(path => resolve(path)));
const acquisition = resolve('src/lib/nearby-v1/acquisition.server.ts');
const sqlStore = resolve('src/lib/nearby-v1/store.server.ts');
const serverPath = resolve('src/lib/plugin-v1/radar-proof-server.ts');
const isZod = id => id.includes('/node_modules/zod/');
const globals = 'const radarGlobals = { __zod_globalConfig: { jitless: true } };';
const diagnostics = [];

async function bundle(input, platform, embedded) {
  const build = await rolldown({ input, platform,
    transform: { define: { Function: 'undefined', globalThis: 'radarGlobals' } },
    plugins: [{ name: 'fake-radar-only-inputs', async load(id) {
      // The original certified engine stays unchanged. Its unused default
      // production constructors become explicit rejecting proof guards.
      if (id === acquisition) return 'export async function acquireNearbyChicago(){throw new Error("Only explicitly injected invented acquisition is permitted in this proof.");}';
      if (id === sqlStore) return 'export function createNearbyCollectionStore(){throw new Error("Only explicitly injected fake proof storage is permitted.");}';
      if (id === serverPath && embedded) {
        const source = await readFile(id, 'utf8');
        return source.replace('import { readFileSync } from "node:fs";\n', '')
          .replace('import { createServer, type IncomingMessage, type ServerResponse } from "node:http";', 'import type { IncomingMessage, ServerResponse } from "node:http";')
          .replace(/^export async function createRadarProofServer\([\s\S]*?^\}/m, '')
          .replace(/const template = \(\) => readFileSync\([^;]+;/, () => `const template = () => ${JSON.stringify(embedded.template)};`)
          .replace(/const widgetScript = \(\) => readFileSync\([^;]+;/, () => `const widgetScript = () => ${JSON.stringify(embedded.widget)};`);
      }
      if (isZod(id) || permitted.has(id)) return null;
      throw new Error(`Forbidden Radar proof deployment input: ${id}`);
    } }],
  });
  try {
    const { output } = await build.generate({ format: platform === 'browser' ? 'iife' : 'esm', minify: true, intro: globals });
    if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('Expected exactly one self-contained Radar chunk.');
    const chunk = output[0];
    const modules = Object.keys(chunk.modules);
    if (modules.some(id => !isZod(id) && !permitted.has(id) && id !== acquisition && id !== sqlStore)) throw new Error('Unexpected Radar proof module.');
    if (chunk.imports.some(id => platform === 'browser' || id !== 'node:crypto')) throw new Error('Unexpected Radar proof external import.');
    try { assertRadarApplication(chunk.code, { widget: platform === 'browser' }); }
    catch (error) {
      await mkdir('artifacts', { recursive: true });
      await writeFile(`artifacts/plugin-v1-radar-rejected-${platform}.js`, chunk.code);
      throw error;
    }
    diagnostics.push({ input, platform, modules, externalImports: chunk.imports, bytes: Buffer.byteLength(chunk.code), sha256: createHash('sha256').update(chunk.code).digest('hex') });
    return chunk.code;
  } finally { await build.close(); }
}

const widget = await bundle('src/lib/plugin-v1/radar-widget.ts', 'browser');
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/plugin-v1-radar-widget.js', widget);
const template = await readFile('docs/plugin-v1/radar-proof/widget.html', 'utf8');
const application = await bundle('src/lib/plugin-v1/radar-proof-preview.ts', 'node', { template, widget });
const directory = resolve('artifacts/plugin-v1-radar-preview');
await mkdir(`${directory}/api`, { recursive: true });
await writeFile(`${directory}/api/mcp.js`, application);
await writeFile(`${directory}/package.json`, JSON.stringify(RADAR_PREVIEW_PACKAGE, null, 2));
await writeFile(`${directory}/vercel.json`, JSON.stringify(RADAR_PREVIEW_CONFIG, null, 2));
await assertRadarPayload(directory);
await cp(directory, 'deploy/plugin-v1-radar-preview', { recursive: true });
await assertRadarPayload('deploy/plugin-v1-radar-preview');
await mkdir('docs/plugin-v1/verification/part-3b3', { recursive: true });
await writeFile('docs/plugin-v1/verification/part-3b3/build-audit.json', JSON.stringify({ fakeAircraftOnly: true, productionSql: false, providerCalls: 0, productionApiCalls: 0, diagnostics, files: ['api/mcp.js', 'package.json', 'vercel.json'] }, null, 2)+'\n');
console.log(JSON.stringify({ directory: 'deploy/plugin-v1-radar-preview', bytes: Buffer.byteLength(application), widgetBytes: Buffer.byteLength(widget), modules: diagnostics.map(entry => entry.modules.length), files: 3, providerCalls: 0 }));
