import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Read-only MCP Inspector equivalent: direct HTTP protocol, never a model turn.
const [endpoint, outputPath, scope] = process.argv.slice(2);
const url = new URL(endpoint);
const preview = url.protocol === 'https:' && url.hostname.startsWith('inbound-live-fixture-') && url.hostname.endsWith('.vercel.app');
const local = scope === '--local-proof' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
if ((!preview && !local) || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) throw new Error('Expected the isolated fixture Preview HTTPS /mcp URL.');
let id = 0;
const evidence = { endpoint, inspectedAt: new Date().toISOString(), inspector: 'independent direct JSON-RPC/Streamable HTTP client', checks: [], toolReads: [] };
const check = (name, condition) => { assert.ok(condition, name); evidence.checks.push(name); };
async function rpc(method, params = {}, notification = false) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: ++id } : {}), method, params }), signal: AbortSignal.timeout(15000) });
  check(`${method}: fixture header`, response.headers.get('x-inbound-fixture-only') === 'true');
  check(`${method}: egress denied header`, response.headers.get('x-inbound-egress') === 'denied');
  assert.equal(response.status, notification ? 202 : 200);
  return notification ? null : response.json();
}
const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Inbound fixture independent inspector', version: '1.0' } });
check('initialization', init.result.serverInfo.name === 'inbound-static-fixture-proof');
await rpc('notifications/initialized', {}, true);
const tools = (await rpc('tools/list')).result.tools;
check('exactly one read-only closed-world fixture tool', tools.length === 1 && tools[0].name === 'fixture_get_nearby_flights' && tools[0].annotations.readOnlyHint && tools[0].annotations.openWorldHint === false);
const resources = (await rpc('resources/list')).result.resources;
check('exactly one fixture UI resource', resources.length === 1 && resources[0].uri === 'ui://inbound/fixture-live-v1.html');
const resource = (await rpc('resources/read', { uri: resources[0].uri })).result.contents[0];
check('self-contained MCP Apps widget', resource.mimeType === 'text/html;profile=mcp-app' && resource.text.includes('STATIC FIXTURES') && !resource.text.includes('__INITIAL_FIXTURE__'));
let first;
for (const area of [{ kind: 'preset', nameOrId: 'chicago' }, { kind: 'airport', code: 'ORD' }, { kind: 'airport', code: 'MDW' }, { kind: 'preset', nameOrId: 'chicago' }]) {
  const r = (await rpc('tools/call', { name: tools[0].name, arguments: { area, limit: 4 } })).result;
  check(`four fixtures: ${r.structuredContent.resolvedArea.id}`, r._meta.fixtureOnly === true && r.structuredContent.flights.length === 4);
  if (!first) first = r.structuredContent;
  else if (area.kind === 'preset') check('reread keeps observation times unchanged', JSON.stringify(r.structuredContent) === JSON.stringify(first));
  evidence.toolReads.push({ areaId: r.structuredContent.resolvedArea.id, readId: r._meta.fixtureReadId, sequence: r._meta.fixtureReadSequence, observedAt: r.structuredContent.flights.map(f => f.freshness.observedAt) });
}
check('distinct fixture read IDs', new Set(evidence.toolReads.map(r => r.readId)).size === 4);
const invalid = (await rpc('tools/call', { name: tools[0].name, arguments: { area: { kind: 'airport', code: 'JFK' }, providerKey: randomUUID() } })).result;
check('unsupported/mixed request rejected', invalid.structuredContent.status === 'invalid_request' && invalid.structuredContent.flights.length === 0);
check('real-flight tool unavailable', (await rpc('tools/call', { name: 'get_flight', arguments: {} })).error.code === -32602);
check('raw files unavailable', (await rpc('resources/read', { uri: 'file:///etc/passwd' })).error.code === -32602);
check('write method unavailable', (await rpc('fixture/write')).error.code === -32601);
evidence.tools = tools.map(t => ({ name: t.name, annotations: t.annotations, resourceUri: t._meta.ui.resourceUri }));
evidence.resources = resources;
evidence.status = 'passed';
if (outputPath) await writeFile(outputPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
