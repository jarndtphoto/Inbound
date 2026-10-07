import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createRadarProofServer } from '../src/lib/plugin-v1/radar-proof-server.ts';

const compiled = process.argv.includes('--compiled');
const expectVulnerable = process.argv.includes('--expect-vulnerable');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const evidenceDirectory = resolve('docs/plugin-v1/verification/part-3b4');
mkdirSync(evidenceDirectory, { recursive: true });

const fixtureNow = Date.parse('2026-10-04T03:00:06Z');
const assertions = [];
const errors = [];
const timeline = [];
let server;
let harness;
let browser;
let dispose;
let root;

const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Handoff replay host simulation</title></head><body>
<h1>Handoff replay host simulation</h1>
<iframe id="radar" title="Invented Radar component" src="/widget" style="width:720px;height:820px;border:1px solid #ddd"></iframe>
<script>
window.radarSavedState={};window.radarHeld=[];window.radarHold=false;window.radarToolResults=[];
const frame=()=>document.getElementById('radar');
window.releaseHeld=index=>{const held=window.radarHeld.splice(index,1)[0];if(held)held.reply();};
window.dispatchGlobals=value=>frame().contentWindow.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:structuredClone(window.radarSavedState),toolOutput:structuredClone(value)}}}));
window.dispatchToolResult=value=>frame().contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:structuredClone(value)},location.origin);
window.callFixture=async(name,args)=>{
 const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:9000+window.radarToolResults.length,method:'tools/call',params:{name,arguments:args}})});
 return (await response.json()).result;
};
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow||event.data?.jsonrpc!=='2.0'||!event.data.method)return;
 const message=event.data;let result;
 if(message.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'REPLAY HOST',version:'0'},hostCapabilities:{},hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}};
 else if(message.method==='tools/call'){
  result=await window.callFixture(message.params.name,message.params.arguments);
  window.radarToolResults.push({name:message.params.name,args:structuredClone(message.params.arguments),result:structuredClone(result)});
  if(window.radarHold)await new Promise(reply=>window.radarHeld.push({name:message.params.name,args:structuredClone(message.params.arguments),result:structuredClone(result),reply}));
 } else return;
 event.source.postMessage({jsonrpc:'2.0',id:message.id,result},event.origin);
});
</script></body></html>`;

const waitFor = async (page, predicate, argument) => {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${String(predicate)}`);
};

try {
  if (compiled) {
    Date.now = () => fixtureNow;
    const { default: handler } = await import(pathToFileURL(resolve('deploy/plugin-v1-radar-preview/api/mcp.js')).href);
    const host = 'inbound-flight-handoff-replay-local.vercel.app';
    process.env = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, VERCEL_ENV: 'preview', VERCEL_URL: host };
    server = createServer((request, response) => {
      request.headers.host = host;
      if (request.headers.origin === root) request.headers.origin = `https://${host}`;
      void handler(request, response);
    });
  } else ({ server, dispose } = await createRadarProofServer({ clock: () => fixtureNow }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  root = `http://127.0.0.1:${server.address().port}`;
  if (compiled) {
    const probe = await fetch(root + '/widget');
    assert.equal(probe.status, 200, `Compiled widget probe failed: ${await probe.text()}`);
  }
  harness = createServer(async (request, response) => {
    if (request.url === '/harness') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(harnessHtml);
      return;
    }
    const buffers = [];
    for await (const chunk of request) buffers.push(chunk);
    const upstream = await fetch(root + (request.url || '/'), {
      method: request.method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      ...(request.method === 'POST' ? { body: Buffer.concat(buffers) } : {}),
    });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  harness.listen(0, '127.0.0.1');
  await once(harness, 'listening');
  const harnessRoot = `http://127.0.0.1:${harness.address().port}`;

  browser = await chromium.launch({
    ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    if (window.parent !== window) {
      window.openai = {
        get widgetState() { return window.parent.radarSavedState; },
        setWidgetState: state => { window.parent.radarSavedState = structuredClone(state); },
      };
    }
  });
  await page.clock.install({ time: new Date(fixtureNow) });
  await page.clock.pauseAt(new Date(fixtureNow));
  await page.goto(harnessRoot + '/harness');
  const frame = page.frameLocator('#radar');
  const read = () => page.evaluate(() => document.getElementById('radar').contentWindow.inboundRadarProof.read());
  const capture = async label => {
    const value = await read();
    timeline.push({ label, handoffMode: value.handoffMode, handoffStatus: value.handoffStatus, selectedRadarId: value.selectedRadarId,
      activeHandoffRequest: value.activeHandoffRequest ?? null, ignoredHandoffReplays: value.ignoredHandoffReplays ?? null,
      appliedHandoffResponses: value.appliedHandoffResponses ?? null });
    return value;
  };
  const selectByIdent = async ident => {
    await frame.locator(`.aircraft-marker[aria-label^="${ident},"]`).click({ force: true });
    await waitFor(page, expected => document.getElementById('radar').contentWindow.inboundRadarProof.read().selectedSelection?.state &&
      document.getElementById('radar').contentWindow.document.getElementById('selected-ident').textContent === expected, ident);
  };
  const retainedResult = async (ident, name = 'resolve_nearby_flight') => {
    await selectByIdent(ident);
    const selection = await read();
    return page.evaluate(({ toolName, token }) => window.callFixture(toolName, { selectionToken: token }), { toolName: name, token: selection.selectedSelection.token });
  };

  await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  await frame.locator('#view-radar').click();
  const staleSyn101 = await retainedResult('SYN101');
  await capture('Radar before retained SYN101 replay');
  await page.evaluate(value => window.dispatchGlobals(value), staleSyn101);
  await capture('Retained SYN101 via openai:set_globals');

  if (expectVulnerable) {
    assert.equal((await read()).handoffMode, 'detail');
    await frame.locator('#back-radar').click();
    await capture('Back to Radar before second replay');
    await page.evaluate(value => window.dispatchToolResult(value), staleSyn101);
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    await capture('Same SYN101 via ui/notifications/tool-result');
    assertions.push('Captured old widget: retained SYN101 globals replay opens detail without Track flight');
    assertions.push('Captured old widget: Back to Radar is overwritten by the same generic tool-result replay');
  } else {
    assert.equal((await read()).handoffMode, 'nearby');
    await page.evaluate(value => window.dispatchToolResult(value), staleSyn101);
    assert.equal((await read()).handoffMode, 'nearby');
    assertions.push('Retained SYN101 is ignored through both globals and generic tool-result before any explicit action');

    await frame.locator('#track-flight').click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    const firstDetail = await capture('Direct correlated SYN101 Track flight response');
    assert.equal(firstDetail.appliedHandoffResponses, 1);
    await page.evaluate(value => { window.dispatchGlobals(value); window.dispatchToolResult(value); }, staleSyn101);
    const duplicateInDetail = await capture('Duplicate SYN101 replays after detail');
    assert.equal(duplicateInDetail.appliedHandoffResponses, 1);
    await frame.locator('#back-radar').click();
    await page.evaluate(value => { window.dispatchGlobals(value); window.dispatchToolResult(value); }, staleSyn101);
    const afterBack = await capture('Back remains authoritative after duplicate SYN101 replays');
    assert.equal(afterBack.handoffMode, 'nearby');
    assert.equal(afterBack.selectedRadarId, firstDetail.selectedRadarId);
    assertions.push('Explicit SYN101 Track opens exactly once; duplicate replay cannot reapply or reopen after Back');

    await frame.locator('#track-flight').click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    assert.equal((await read()).appliedHandoffResponses, 2);
    await frame.locator('#back-radar').click();
    assertions.push('A new explicit Track action creates a new correlated request and may reopen SYN101 detail');

    const staleSyn105 = await retainedResult('SYN105');
    assert.equal(staleSyn105.structuredContent?.status ?? staleSyn105.status, 'ambiguous');
    await page.evaluate(value => { window.dispatchGlobals(value); window.dispatchToolResult(value); }, staleSyn105);
    assert.equal((await read()).handoffMode, 'nearby');
    await frame.locator('#track-flight').click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'ambiguous');
    assert.equal(await frame.locator('.candidate').count(), 2);
    await frame.locator('.candidate').first().click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    const chosenResult = await page.evaluate(() => window.radarToolResults.at(-1).result);
    await frame.locator('#back-radar').click();
    await page.evaluate(values => { for (const value of values) { window.dispatchGlobals(value); window.dispatchToolResult(value); } }, [staleSyn105, chosenResult]);
    assert.equal((await read()).handoffMode, 'nearby');
    assertions.push('SYN105 selection stays Radar; explicit Track opens ambiguity; only the direct choice response opens detail; stale ambiguity/choice replays stay ignored');

    await selectByIdent('SYN101');
    await page.evaluate(() => { window.radarHold = true; });
    await frame.locator('#track-flight').click();
    await waitFor(page, () => window.radarHeld.length === 1);
    await frame.locator('#back-radar').click();
    await selectByIdent('SYN105');
    await frame.locator('#track-flight').click();
    await waitFor(page, () => window.radarHeld.length === 2);
    await page.evaluate(() => window.releaseHeld(0));
    await waitFor(page, () => window.radarHeld.length === 1);
    const afterOldA = await capture('Late SYN101 A after SYN105 B started');
    assert.equal(afterOldA.handoffMode, 'loading');
    await page.evaluate(() => window.releaseHeld(0));
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    assert.match(await frame.locator('#detail-ident').innerText(), /SYN105/);
    await capture('Correlated SYN105 B accepted after late SYN101 A ignored');
    assertions.push('Late request A cannot override newer request B; only the current request may complete navigation');

    assert.equal(errors.length, 0);
  }

  const output = {
    mode: expectVulnerable ? 'pre-fix-capture' : compiled ? 'compiled-replay-proof' : 'source-replay-proof',
    assertions: assertions.length,
    failures: 0,
    errors,
    timeline,
    assertionText: assertions,
  };
  const file = expectVulnerable ? 'host-replay-root-cause-before.json' : `host-replay-proof${compiled ? '-compiled' : ''}.json`;
  writeFileSync(resolve(evidenceDirectory, file), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify(output, null, 2));
} finally {
  if (browser) await browser.close();
  if (dispose) dispose();
  for (const handle of [harness, server]) if (handle) {
    handle.closeAllConnections();
    await new Promise(resolveClose => handle.close(resolveClose));
  }
}
