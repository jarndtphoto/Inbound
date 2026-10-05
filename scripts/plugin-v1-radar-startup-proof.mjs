import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createRadarProofServer } from '../src/lib/plugin-v1/radar-proof-server.ts';
import { installTestClock } from './test-clock.mjs';

// Reopen a real resource after its embedded observations have aged. The parent
// is a simulated host; this does not claim actual ChatGPT host approval.
const compiled = process.argv.includes('--compiled');
const before = process.argv.includes('--before');
const epoch = Date.parse('2026-10-04T03:00:06Z');
let now = epoch;
const restoreClock = installTestClock(() => now);
const previousEnvironment = process.env;
const errors = [], timeline = [];
let server, harness, browser, dispose, root;
let cachedHtml, retainedFlight;
const evidence = resolve('docs/plugin-v1/verification/part-3b4');
mkdirSync(evidence, { recursive: true });

const harnessHtml = `<!doctype html><html><body>
<iframe id="radar" src="/cached-widget" style="width:720px;height:820px"></iframe>
<script>
window.saved={};window.calls=[];
window.addEventListener('message',async event=>{
 if(event.source!==document.getElementById('radar').contentWindow||event.data?.jsonrpc!=='2.0')return;
 const message=event.data;let result;
 if(message.method==='ui/initialize')result={hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}};
 else if(message.method==='tools/call'){
  window.calls.push(message.params.name);
  const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:message.id,method:'tools/call',params:message.params})});
  result=(await response.json()).result;
 }else return;
 event.source.postMessage({jsonrpc:'2.0',id:message.id,result},event.origin);
});
</script></body></html>`;

async function rpc(method, params) {
 const response = await fetch(root + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
 assert.equal(response.status, 200);
 return (await response.json()).result;
}
async function waitFor(page, predicate) {
 const deadline = performance.now() + 10_000;
 while (performance.now() < deadline) {
  if (await page.evaluate(predicate)) return;
  await delay(20);
 }
 throw new Error('Startup proof timed out');
}

try {
 if (compiled) {
  const { default: handler } = await import(pathToFileURL(resolve('deploy/plugin-v1-radar-preview/api/mcp.js')).href);
  const host = 'inbound-startup-local.vercel.app';
  process.env = { NO_PROXY: previousEnvironment.NO_PROXY, no_proxy: previousEnvironment.no_proxy, VERCEL_ENV: 'preview', VERCEL_URL: host };
  server = createServer((req, res) => { req.headers.host = host; void handler(req, res); });
 } else ({ server, dispose } = await createRadarProofServer({ clock: () => now }));
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 root = `http://127.0.0.1:${server.address().port}`;
 const resources = await rpc('resources/list', {});
 cachedHtml = (await rpc('resources/read', { uri: resources.resources[0].uri })).contents[0].text;
 const launchBoard = (await rpc('tools/call', { name: 'get_nearby_flights', arguments: { area: 'preset:chicago', limit: 4 } })).structuredContent;
 const syn101 = launchBoard.radarTargets.find(target => target.displayIdent === 'SYN101');
 assert.ok(syn101);
 retainedFlight = await rpc('tools/call', { name: 'resolve_nearby_flight', arguments: { selectionToken: syn101.selection.token } });
 harness = createServer(async (req, res) => {
  if (req.url === '/harness' || req.url === '/cached-widget') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(req.url === '/harness' ? harnessHtml : cachedHtml); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const upstream = await fetch(root + req.url, { method: req.method, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
   ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') }); res.end(Buffer.from(await upstream.arrayBuffer()));
 });
 harness.listen(0, '127.0.0.1'); await once(harness, 'listening');
 browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium-headless-shell', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader'] });
 const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
 for (const ageSeconds of before ? [30] : [0, 30, 130]) {
  now = epoch + ageSeconds * 1000;
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.addInitScript(({ flight, radarId }) => {
   if (window.parent !== window) window.openai = {
    widgetState: { version: 4, areaId: 'preset:chicago', selectedRadarId: radarId, views: { inline: 'radar', fullscreen: 'radar', pip: 'flights' }, paused: false },
    toolOutput: flight,
    setWidgetState: state => { window.parent.saved = structuredClone(state); },
   };
  }, { flight: retainedFlight, radarId: syn101.radarId });
  await page.clock.install({ time: new Date(now) }); await page.clock.pauseAt(new Date(now));
  await page.goto(`http://127.0.0.1:${harness.address().port}/harness`);
  await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  const read = () => page.evaluate(() => document.getElementById('radar').contentWindow.inboundRadarProof.read());
  if (!before && ageSeconds > 0) await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > 0);
  await page.clock.runFor(250); now += 250;
  let state = await read();
  timeline.push({ ageSeconds, refreshCalls: state.refreshCalls, nextPollAt: state.nextPollAt, generatedAt: state.generatedAt,
   syn101: state.displayPositions.find(target => target.radarId === syn101.radarId), handoffMode: state.handoffMode });
  assert.equal(state.handoffMode, 'nearby', 'A retained flight result must never navigate');
  assert.equal(state.selectedRadarId, syn101.radarId, 'Startup preserves SYN101 selection');
  if (before) {
   assert.equal(state.refreshCalls, 0, 'Old startup waits a full normal poll interval');
   assert.equal(state.displayPositions.find(target => target.radarId === syn101.radarId).stopped, true);
  } else {
   if (ageSeconds === 0) assert.equal(state.refreshCalls, 0, 'A fresh launch keeps its normal polling cadence');
   // Collection construction is asynchronous; exercise its bounded recovery
   // instead of letting the proof manufacture a new observation timestamp.
   for (let attempt = 0; attempt < 3 && state.displayPositions.find(target => target.radarId === syn101.radarId)?.stopped !== false; attempt++) {
    now += 4_000; await page.clock.runFor(4_000); await delay(100); state = await read();
   }
   const start = state.displayPositions.find(target => target.radarId === syn101.radarId);
   assert.equal(start?.stopped, false, 'Fresh authoritative startup restores bounded motion');
   now += 500; await page.clock.runFor(500);
   const later = (await read()).displayPositions.find(target => target.radarId === syn101.radarId);
   assert.notDeepEqual([later.latitude, later.longitude], [start.latitude, start.longitude], 'SYN101 visibly moves after startup without manual Refresh');
   assert.equal(state.pollTimers.maxPending, 1); assert.equal(state.ageTimers.maxPending, 1);
   await page.frameLocator('#radar').locator('.aircraft-marker[aria-label^="SYN101,"]').click({ force: true });
   assert.equal((await read()).handoffMode, 'nearby');
   await page.frameLocator('#radar').locator('#track-flight').click();
   await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
   await page.frameLocator('#radar').locator('#back-radar').click();
   assert.equal((await read()).handoffMode, 'nearby');
  }
  await page.close();
 }
 assert.deepEqual(errors, []);
 const result = { ok: true, compiled, before, scope: 'Simulated delayed-resource host only', actualChatGptVerified: false, errors, timeline };
 writeFileSync(resolve(evidence, `startup-${before ? 'before' : 'proof'}${compiled ? '-compiled' : ''}.json`), JSON.stringify(result, null, 2) + '\n');
 console.log(JSON.stringify(result));
} finally {
 await browser?.close(); dispose?.();
 for (const instance of [harness, server]) if (instance) { instance.closeAllConnections(); await new Promise(done => instance.close(done)); }
 process.env = previousEnvironment; restoreClock();
}
