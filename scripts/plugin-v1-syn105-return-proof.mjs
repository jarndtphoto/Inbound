import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { installTestClock } from './test-clock.mjs';

const before = process.argv.includes('--before');
const epoch = Date.parse('2026-10-05T13:00:06Z');
let now = epoch, worker = 0;
const restoreClock = installTestClock(() => now);
const previousEnvironment = process.env;
process.env = { NO_PROXY: previousEnvironment.NO_PROXY, no_proxy: previousEnvironment.no_proxy, VERCEL_ENV: 'preview', VERCEL_URL: 'inbound-syn105-local.vercel.app' };
const file = resolve(before ? 'artifacts/plugin-v1-syn105-before.mjs' : 'deploy/plugin-v1-radar-preview/api/mcp.js');
const handlers = [];
for (let index = 0; index < (before ? 1 : 3); index++) handlers.push((await import(pathToFileURL(file).href + '?worker=' + index)).default);
const errors = [], assertions = [], timeline = [];
let browser;
const html = `<!doctype html><body><iframe id="radar" src="/widget" style="width:273px;height:1300px;border:0"></iframe><script>
window.saved={};window.results=[];window.hold=false;window.held=[];window.failChoice=false;
const frame=()=>document.getElementById('radar');
window.release=()=>window.held.splice(0).forEach(fn=>fn());
window.replay=()=>window.results.forEach(result=>{
 frame().contentWindow.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{toolOutput:result}}}));
 frame().contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result},location.origin);
});
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow||event.data?.jsonrpc!=='2.0')return;
 const message=event.data;let result;
 if(message.method==='ui/initialize')result={hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}};
 else if(message.method==='tools/call'){
  const params=structuredClone(message.params);
  if(window.failChoice&&params.name==='get_flight'&&params.arguments.target.kind==='choice')params.arguments.target.candidateToken='A'.repeat(43);
  const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:message.id,method:'tools/call',params})});
  result=(await response.json()).result;window.results.push(structuredClone(result));
  if(window.hold&&params.name!=='get_nearby_flights')await new Promise(resolve=>window.held.push(resolve));
 }else return;
 event.source.postMessage({jsonrpc:'2.0',id:message.id,result},event.origin);
});</script>`;
const server = createServer((req, res) => {
  if (req.url === '/harness') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return; }
  req.headers.host = process.env.VERCEL_URL;
  if (req.headers.origin?.startsWith('http://127.0.0.1:')) req.headers.origin = 'https://' + process.env.VERCEL_URL;
  void handlers[(worker++) % handlers.length](req, res);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
async function waitFor(page, predicate) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) { if (await page.evaluate(predicate)) return; await delay(20); }
  throw Error('SYN105 proof timed out');
}
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium-headless-shell', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 1400 }, colorScheme: 'dark' });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => { if (window.parent !== window) window.openai = {
    widgetState: { version: 4, areaId: 'preset:chicago', selectedRadarId: null, views: { inline: 'radar', fullscreen: 'radar', pip: 'flights' }, paused: false },
    setWidgetState: state => { window.parent.saved = structuredClone(state); },
  }; });
  await page.clock.install({ time: new Date(now) }); await page.clock.pauseAt(new Date(now));
  await page.goto('http://127.0.0.1:' + server.address().port + '/harness');
  await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  const frame = page.frameLocator('#radar');
  const read = () => page.evaluate(() => document.getElementById('radar').contentWindow.inboundRadarProof.read());
  const syn105 = '[data-radar-id="00000000-0000-4000-8000-000000003e84"]';
  async function ambiguous() {
    await frame.locator(syn105).press('Enter'); await frame.locator('#track-flight').click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'ambiguous');
    assert.equal(await frame.locator('.candidate').count(), 2);
  }
  await ambiguous();
  await page.evaluate(() => { const doc = document.getElementById('radar').contentDocument; window.choiceNode = doc.querySelector('.candidate'); window.choiceNode.focus(); });
  now += 1200; await page.clock.runFor(1200);
  const retained = await page.evaluate(() => window.choiceNode.isConnected && document.getElementById('radar').contentDocument.activeElement === window.choiceNode);
  timeline.push({ label: 'Candidate focus across age render', retained });
  assert.equal(retained, !before);
  if (before) assertions.push('Old compiled artifact replaces the dated-choice button during an age tick and loses focus');
  else assertions.push('Dated-choice button and keyboard focus survive the age render');

  await page.evaluate(() => { window.failChoice = true; });
  await frame.locator('.candidate').first().click();
  await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'error');
  assert.match(await frame.locator('#handoff-error').innerText(), /handle is invalid/);
  await page.screenshot({ path: 'docs/plugin-v1/verification/part-3b4/syn105-error' + (before ? '-before' : '') + '.png' });
  await page.evaluate(() => document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: null, availableDisplayModes: null } }, location.origin));
  await delay(30); await frame.locator('#back-radar').click();
  const visible = await frame.locator('#radar-panel').isVisible();
  timeline.push({ label: 'Back after invalid choice and malformed optional context', visible, mode: before ? 'proof read also fails on malformed context' : (await read()).handoffMode });
  assert.equal(visible, !before);
  if (before) assertions.push('Old compiled host-control render exception leaves the error panel visible after Back');
  else {
    assertions.push('Back from invalid choice returns visibly to Radar despite malformed optional host context');
    await page.evaluate(() => { window.failChoice = false; window.replay(); });
    assert.equal((await read()).handoffMode, 'nearby');
    await ambiguous(); await frame.locator('.candidate').nth(1).click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    assert.match(await frame.locator('#detail-ident').innerText(), /SYN105/);
    await frame.locator('#back-radar').click(); await page.evaluate(() => window.replay());
    assert.equal((await read()).handoffMode, 'nearby'); assert.ok(await frame.locator('#radar-panel').isVisible());
    assertions.push('SYN105 second dated choice resolves across alternating workers; Back ignores retained ambiguity/detail/error replays');

    // Actual ChatGPT host regression: after Back, tracking SYN105 again must
    // reopen the two dated choices instead of reusing the prior chosen instance.
    await ambiguous();
    assert.equal(await frame.locator('.candidate').count(), 2);
    assertions.push('After Back, reselecting SYN105 and Track flight reopens both dated choices instead of the previous exact occurrence');
    await frame.locator('.candidate').first().click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    await frame.locator('#back-radar').click();

    await frame.locator('#view-flights').click(); await frame.locator('#track-flight').click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'ambiguous');
    assert.equal(await frame.locator('.candidate').count(), 2);
    await frame.locator('.candidate').first().click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    await frame.locator('#back-radar').click(); assert.equal((await read()).selectedView, 'radar');
    assertions.push('Back entered from Flights opens the Radar map and retains the selected aircraft');

    const syn101 = '[data-radar-id="00000000-0000-4000-8000-000000003e80"]';
    await frame.locator(syn101).press('Enter'); await frame.locator('#track-flight').click();
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    await frame.locator('#back-radar').click();
    await page.evaluate(() => { window.hold = true; }); await frame.locator('#track-flight').click();
    await waitFor(page, () => window.held.length === 1); await frame.locator('#back-radar').click();
    await page.evaluate(() => { window.release(); window.hold = false; }); await delay(30);
    assert.equal((await read()).handoffMode, 'nearby');
    assertions.push('Back cancels an in-flight exact-instance read; its later direct response cannot reopen detail');
    const selected = (await read()).selectedRadarId;
    await frame.locator('#track-flight').click(); await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().handoffMode === 'detail');
    await frame.locator('#view-radar').click(); assert.ok(await frame.locator('#radar-panel').isVisible());
    assert.equal((await read()).selectedRadarId, selected); assertions.push('Radar tab also exits detail locally without losing the selection');
    now += 20000; await page.clock.runFor(20000); await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > 0);
    const state = await read(); assert.equal(state.pollTimers.maxPending, 1); assert.equal(state.ageTimers.maxPending, 1);
    assert.ok(state.displayPositions.some(position => !position.stopped)); assert.deepEqual(errors, []);
    assertions.push('Automatic Nearby refresh and bounded motion remain active with singleton timers and no browser errors');
    await page.screenshot({ path: 'docs/plugin-v1/verification/part-3b4/syn105-back-radar.png' });
  }
  const report = { ok: true, before, compiled: true, workerCount: handlers.length, actualChatGptHostApproved: false,
    scope: 'Simulated host; malformed-context case is fault injection, not a proven actual-host cause', assertions, errors, timeline };
  writeFileSync('docs/plugin-v1/verification/part-3b4/syn105-return' + (before ? '-before' : '') + '.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser?.close(); server.closeAllConnections(); server.close(); process.env = previousEnvironment; restoreClock(); }
