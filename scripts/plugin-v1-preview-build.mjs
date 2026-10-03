import { rolldown } from 'rolldown';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit allowlist: neither app configuration nor provider/DB modules can ship.
const permitted = new Set([
  'src/lib/plugin-v1/proof-preview.ts', 'src/lib/plugin-v1/proof-egress.ts',
  'src/lib/plugin-v1/proof-server.ts', 'src/lib/plugin-v1/contracts.ts',
  'src/lib/plugin-v1/areas.ts', 'src/lib/plugin-v1/fixtures.ts',
  'src/lib/geo.ts', 'src/lib/airports.ts',
].map(p => resolve(p)));
const widget = await readFile('docs/plugin-v1/proof/widget.html', 'utf8');
const build = await rolldown({
  input: 'src/lib/plugin-v1/proof-preview.ts', platform: 'node',
  plugins: [{ name: 'fixture-only-files',
    async load(id) {
      if (id === resolve('src/lib/plugin-v1/proof-server.ts')) {
        const source = await readFile(id, 'utf8');
        return source.replace('import { readFileSync } from "node:fs";\n', '').replace(/const template = \(\) => readFileSync\([^;]+;/, () => `const template = () => ${JSON.stringify(widget)};`);
      }
      if (id.includes('/node_modules/zod/') || permitted.has(id)) return null;
      throw new Error(`Forbidden fixture deployment input: ${id}`);
    },
  }],
});
try {
  const { output } = await build.generate({ format: 'esm', minify: true });
  if (output.length !== 1 || output[0].type !== 'chunk') throw new Error('Expected one self-contained fixture function.');
  const chunk = output[0];
  const modules = Object.keys(chunk.modules);
  if (modules.some(id => !id.includes('/node_modules/zod/') && !permitted.has(id))) throw new Error('Forbidden module in fixture deployment.');
  const permittedBuiltins = new Set(['node:module', 'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:dgram', 'node:child_process', 'node:crypto']);
  if (chunk.imports.some(id => !permittedBuiltins.has(id))) throw new Error('Forbidden external import in fixture deployment.');
  const directory = resolve('artifacts/plugin-v1-fixture-preview');
  await mkdir(`${directory}/api`, { recursive: true });
  await writeFile(`${directory}/api/mcp.js`, chunk.code);
  await writeFile(`${directory}/package.json`, JSON.stringify({ name: 'inbound-live-fixture-preview', private: true, type: 'module', engines: { node: '22.x' } }, null, 2));
  await writeFile(`${directory}/vercel.json`, JSON.stringify({ version: 2, rewrites: [{ source: '/mcp', destination: '/api/mcp' }, { source: '/widget', destination: '/api/mcp' }, { source: '/', destination: '/api/mcp' }], functions: { 'api/mcp.js': { maxDuration: 10 } } }, null, 2));
  await writeFile(`${directory}/audit.json`, JSON.stringify({ fixtureOnly: true, modules, externalImports: chunk.imports, bytes: chunk.code.length }, null, 2));
  console.log(JSON.stringify({ directory, bytes: chunk.code.length, modules: modules.length, externalImports: chunk.imports, fixtureOnly: true }));
} finally { await build.close(); }
