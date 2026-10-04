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

// Actual isolated engine/serializer/MCP/widget, with invented data. The parent
// below SIMULATES host messages only: this does not certify a ChatGPT host or PiP.
const compiled = process.argv.includes('--compiled');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const evidence = resolve('docs/plugin-v1/verification/part-3b3');
const suffix = compiled ? '-compiled' : '';
mkdirSync(evidence, { recursive: true });
let simulationNow = Date.parse('2026-10-04T03:00:06Z');
const restoreClock = installTestClock(() => simulationNow);
const previousEnvironment = process.env;
const assertions = [];
const errors = [];
const displayTransitions = [];
let externalRequests = 0;
let server, harness, browser, page, stats, root, dispose;

const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>SIMULATED HOST — not ChatGPT</title></head><body>
<h1>SIMULATED HOST — not ChatGPT</h1><p>Component messages only. No real PiP or ChatGPT host approval is claimed.</p>
<button id="remount">Remount component</button><button id="teardown">Send simulated teardown</button>
<iframe id="radar" title="Invented Radar component" src="/widget" style="width:680px;height:790px;border:1px solid #ddd"></iframe>
<script>
window.radarSavedState={};window.radarMessages=[];window.radarTeardownAcknowledged=false;
window.radarDisplayResponses=[];
window.radarModes=['inline','fullscreen'];window.radarDisplayMode='inline';window.radarAcceptDisplay=false;
const frame=()=>document.getElementById('radar');
document.getElementById('remount').onclick=()=>{frame().src='/widget';};
document.getElementById('teardown').onclick=()=>{frame().contentWindow.postMessage({jsonrpc:'2.0',id:777,method:'ui/resource-teardown',params:{reason:'simulated session ended'}},location.origin);};
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow || event.data?.jsonrpc!=='2.0')return;
 const m=event.data;if(m.id===777&&m.result){window.radarTeardownAcknowledged=true;return;}
 if(!m.method)return;window.radarMessages.push(m.method);let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'SIMULATED HOST',version:'0'},hostCapabilities:{},hostContext:{displayMode:window.radarDisplayMode,availableDisplayModes:window.radarModes}};
 else if(m.method==='tools/call'){const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:m.id,method:'tools/call',params:m.params})});result=(await response.json()).result;window.radarLastResult=result;}
 else if(m.method==='ui/request-display-mode'){result={mode:window.radarAcceptDisplay ? m.params.mode : 'inline'};window.radarDisplayMode=result.mode;}
 else return;
 event.source.postMessage({jsonrpc:'2.0',id:m.id,result},event.origin);
 if(m.method==='ui/request-display-mode')window.radarDisplayResponses.push({id:m.id,requested:m.params.mode,granted:result.mode});
});
</script></body></html>`;

// Poll with real test-runner timers while the component wall clock/RAF is paused.
const waitForState = async (page, predicate, argument) => {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await delay(25);
  }
  throw new Error(`Component state timed out: ${String(predicate)}`);
};
const locate = (page, radarId) => page.locator(`.aircraft-marker[data-radar-id="${radarId}"]`);
const canonicalPositions = positions => [...positions].sort((a, b) => a.radarId.localeCompare(b.radarId));
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const labelGeometry = async container => container.locator('.marker-label').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().width > 0).map(n => ({ radarId: n.dataset.radarId || n.parentElement.dataset.radarId, ...n.getBoundingClientRect().toJSON() })));
const assertLabels = async (container, limit, selected) => {
  const labels = await labelGeometry(container);
  assert.ok(labels.length <= limit, `${labels.length} labels exceeds ${limit}`);
  assert.ok(labels.some(label => label.radarId === selected), 'Selected aircraft retains a label');
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) assert.equal(overlaps(labels[i], labels[j]), false, 'Displayed labels do not collide');
  return labels;
};

try {
  if (compiled) {
    const { default: handler } = await import(pathToFileURL(resolve('deploy/plugin-v1-radar-preview/api/mcp.js')).href);
    const host = 'inbound-radar-transport-local-test.vercel.app';
    process.env = { NO_PROXY: previousEnvironment.NO_PROXY, no_proxy: previousEnvironment.no_proxy, VERCEL_ENV: 'preview', VERCEL_URL: host };
    stats = { toolCalls: 0 };
    server = createServer((req, res) => {
      req.headers.host = host;
      if (req.headers.origin === root) req.headers.origin = `https://${host}`;
      if (req.method === 'POST' && req.url === '/mcp') stats.toolCalls++;
      void handler(req, res);
    });
  } else ({ server, stats, dispose } = await createRadarProofServer({ clock: () => simulationNow }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  root = `http://127.0.0.1:${server.address().port}`;
  harness = createServer(async (req, res) => {
    if (req.url === '/harness') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(harnessHtml); return; }
    try {
      const buffers = []; for await (const bytes of req) buffers.push(bytes);
      const response = await fetch(root + (req.url || '/'), { method: req.method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' }, ...(req.method === 'POST' ? { body: Buffer.concat(buffers) } : {}) });
      res.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') || 'text/plain' });
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('Local component proxy failed'); }
  });
  harness.listen(0, '127.0.0.1'); await once(harness, 'listening');
  const harnessRoot = `http://127.0.0.1:${harness.address().port}`;
  browser = await chromium.launch({ ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', route => { const host = new URL(route.request().url()).hostname; if (!['127.0.0.1', 'localhost'].includes(host)) { externalRequests++; return route.abort(); } return route.continue(); });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.clock.install({ time: new Date(simulationNow - 1_000) });
  await page.clock.pauseAt(new Date(simulationNow));
  const advance = async duration => { simulationNow += duration; await page.clock.runFor(duration); };
  const jump = async duration => { simulationNow += duration; await page.clock.fastForward(duration); };
  const read = () => page.evaluate(() => window.inboundRadarProof.read());

  await page.goto(root + '/widget');
  await waitForState(page, () => Boolean(window.inboundRadarProof));
  assert.equal(await page.locator('.card').count(), 4);
  assert.equal(await page.locator('#view-flights').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#pip').isEnabled(), false);
  assert.equal(await page.locator('#fullscreen').isEnabled(), false);
  assertions.push('Standalone inline defaults to four Featured cards; unavailable host controls stay disabled');
  await page.locator('#view-radar').click();
  const initial = await read();
  assert.equal(initial.positions.length, 40);
  assert.equal(await page.locator('.aircraft-marker').count(), 40);
  let overlappingCenters = 0;
  for (const target of initial.positions) {
    const hit = await locate(page, target.radarId).evaluate(node => {
      const rect = node.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { x, y, overlap: document.elementFromPoint(x, y)?.closest('.aircraft-marker') !== node };
    });
    if (hit.overlap) overlappingCenters++;
    await page.mouse.click(hit.x, hit.y);
    assert.equal((await read()).selectedRadarId, target.radarId, 'Genuine pointer selects nearest glyph even when another hit area is on top');
  }
  assert.ok(overlappingCenters > 0, 'Dense fixture exercises overlapping hit areas');
  assertions.push('All forty glyph centers select the intended aircraft with genuine pointer events, including overlapping touch areas');
  const moving = initial.positions.find(target => target.groundTrackDeg !== null && target.groundspeedKt > 0);
  const neutral = initial.positions.find(target => target.groundTrackDeg === null);
  const retiring = [...initial.positions].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0];
  assert.ok(moving && neutral && retiring);
  await locate(page, moving.radarId).click({ force: true });
  assert.equal(await locate(page, moving.radarId).getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#selected-track').innerText(), /Track/);
  assert.doesNotMatch(await page.locator('#selected-track').innerText(), /Heading/i);
  assert.equal(await locate(page, neutral.radarId).getAttribute('data-track'), 'neutral');
  assert.equal(await locate(page, neutral.radarId).locator('.aircraft-glyph').evaluate(node => node.style.transform), '');
  assert.match(await locate(page, moving.radarId).locator('.aircraft-glyph').evaluate(node => node.style.transform), /rotate\(/);
  assert.equal(await page.locator('#track-flight').isEnabled(), false);
  assertions.push('Forty invented targets render directional accepted track and a neutral missing-track symbol; Track flight remains disabled');

  const beforeMotionCalls = stats.toolCalls;
  const motionSamples = [];
  for (let i = 0; i < 4; i++) {
    await advance(500); const state = await read();
    const display = state.displayPositions.find(target => target.radarId === moving.radarId);
    const css = await locate(page, moving.radarId).evaluate(node => ({ left: node.style.left, top: node.style.top }));
    motionSamples.push({ ...display, css });
  }
  assert.ok(motionSamples.every(Boolean));
  for (let i = 1; i < motionSamples.length; i++) {
    assert.notDeepEqual([motionSamples[i].latitude, motionSamples[i].longitude], [motionSamples[i - 1].latitude, motionSamples[i - 1].longitude]);
    assert.notDeepEqual(motionSamples[i].css, motionSamples[i - 1].css, 'Visible marker position changes between animation frames');
  }
  assert.ok((await read()).frameCount > initial.frameCount + 20, 'Continuous animation frames ran');
  assert.equal(stats.toolCalls, beforeMotionCalls, 'Animation does not create MCP requests');
  assert.deepEqual((await read()).positions, initial.positions, 'Animation leaves authoritative anchors unchanged');
  const neutralInitial = initial.positions.find(target => target.radarId === neutral.radarId);
  const neutralDisplay = (await read()).displayPositions.find(target => target.radarId === neutral.radarId);
  assert.equal(neutralDisplay.latitude, neutralInitial.latitude); assert.equal(neutralDisplay.longitude, neutralInitial.longitude);
  assert.equal(neutralDisplay.extrapolatedSeconds, 0);
  assert.ok(motionSamples.every(position => position.altitudeFt === moving.altitudeFt), 'Altitude remains authoritative');
  assertions.push('Repeated RAF frames visibly move aircraft with the certified motion function; authoritative fixes/altitude stay unchanged and animation causes no MCP calls');

  await page.locator('#pause').click();
  const pausedRequests = (await read()).refreshCalls;
  await jump(Date.parse(moving.observedAt) + 25_000 - simulationNow);
  const stopped = (await read()).displayPositions.find(target => target.radarId === moving.radarId);
  assert.equal(stopped.extrapolatedSeconds, 25); assert.equal(stopped.stopped, true);
  await jump(5_000);
  const stoppedLater = (await read()).displayPositions.find(target => target.radarId === moving.radarId);
  assert.deepEqual([stoppedLater.latitude, stoppedLater.longitude], [stopped.latitude, stopped.longitude]);
  assert.equal((await read()).refreshCalls, pausedRequests);
  assertions.push('Paused polling still allows bounded local motion, which stops at 25 seconds and never drifts farther');
  await locate(page, retiring.radarId).focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#selected-age').innerText(), /Stale/i);
  assert.equal((await read()).displayPositions.find(target => target.radarId === retiring.radarId).stopped, true);
  await page.locator('#pause').click();
  await waitForState(page, before => window.inboundRadarProof.read().refreshCalls > before, pausedRequests);
  const replaced = await read();
  const replacement = replaced.positions.find(target => target.radarId === moving.radarId);
  assert.ok(Date.parse(replacement.observedAt) > Date.parse(moving.observedAt));
  assert.notDeepEqual([replacement.latitude, replacement.longitude], [moving.latitude, moving.longitude]);
  assert.ok(replaced.collectionVersion > initial.collectionVersion);
  assert.equal(replaced.selectedRadarId, retiring.radarId);
  assert.equal(await locate(page, retiring.radarId).count(), 0);
  assert.match(await page.locator('#selected-age').innerText(), /retained/i);
  await locate(page, moving.radarId).focus(); await page.keyboard.press('Enter');
  assertions.push('A deterministic authoritative update replaces the anchor; the stale retiring target drops out without silently switching its selected panel');
  await locate(page, moving.radarId).focus();
  const periodicBefore = (await read()).refreshCalls;
  await jump(20_000);
  await waitForState(page, before => window.inboundRadarProof.read().refreshCalls > before, periodicBefore);
  const secondReplacement = (await read()).positions.find(target => target.radarId === moving.radarId);
  assert.equal(Date.parse(secondReplacement.observedAt) - Date.parse(replacement.observedAt), 20_000);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.radarId), moving.radarId);
  assert.equal((await read()).selectedRadarId, moving.radarId);
  assertions.push('The next 20-second refresh produces an accepted T+40 fix and preserves keyboard focus and selected aircraft');

  await page.locator('#view-flights').click();
  assert.equal((await read()).selectedRadarId, moving.radarId);
  await page.locator('#view-radar').click();
  await page.locator('#view-radar').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#view-flights').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('#view-radar').getAttribute('aria-selected'), 'true');
  await locate(page, moving.radarId).focus(); await page.keyboard.press('Enter');
  assert.equal(await locate(page, moving.radarId).getAttribute('aria-pressed'), 'true');
  assert.ok(await locate(page, moving.radarId).evaluate(node => getComputedStyle(node).outlineStyle !== 'none'), 'Focused target has visible outline');
  const desktopLabels = await assertLabels(page, 8, moving.radarId);
  const version = (await read()).collectionVersion;
  const chicagoPositions = (await read()).positions;
  const chicagoMarkers = await page.locator('.aircraft-marker').evaluateAll(nodes => nodes.map(node => [node.style.left, node.style.top]));
  await page.locator('#area').selectOption('airport:KORD'); await waitForState(page, () => window.inboundRadarProof.read().areaId === 'airport:KORD');
  assert.equal((await read()).collectionVersion, version);
  assert.equal(await page.locator('[data-airport="ORD"]').getAttribute('data-primary'), 'true');
  const ordLabels = await assertLabels(page, 8, moving.radarId);
  const ordMarkers = await page.locator('.aircraft-marker').evaluateAll(nodes => nodes.map(node => [node.style.left, node.style.top]));
  await page.locator('#area').selectOption('airport:KMDW'); await waitForState(page, () => window.inboundRadarProof.read().areaId === 'airport:KMDW');
  assert.equal((await read()).collectionVersion, version);
  assert.equal(await page.locator('[data-airport="MDW"]').getAttribute('data-primary'), 'true');
  const mdwLabels = await assertLabels(page, 8, moving.radarId);
  const mdwMarkers = await page.locator('.aircraft-marker').evaluateAll(nodes => nodes.map(node => [node.style.left, node.style.top]));
  assert.notDeepEqual(chicagoMarkers, ordMarkers); assert.notDeepEqual(ordMarkers, mdwMarkers);
  assert.deepEqual(canonicalPositions((await read()).positions), canonicalPositions(chicagoPositions));
  await page.locator('#area').selectOption('preset:chicago'); await waitForState(page, () => window.inboundRadarProof.read().areaId === 'preset:chicago');
  assertions.push('Keyboard tabs/target focus and selection work; Chicago/ORD/MDW re-center one collection version without mutating accepted fixes');
  await page.reload(); await waitForState(page, () => Boolean(window.inboundRadarProof));
  assert.equal((await read()).selectedRadarId, moving.radarId);
  assertions.push('Standalone session storage restores the exact selected aircraft after reload');

  // Explicitly simulated host messages; no native host/PiP implementation is exercised.
  await page.addInitScript(() => {
    if (window.parent !== window) window.openai = { get widgetState() { return window.parent.radarSavedState; }, setWidgetState: state => { window.parent.radarSavedState = state; } };
  });
  await page.goto(harnessRoot + '/harness');
  const frame = page.frameLocator('#radar');
  const frameRead = () => page.evaluate(() => document.getElementById('radar').contentWindow.inboundRadarProof.read());
  const displayState = () => page.evaluate(() => {
    const component = document.getElementById('radar').contentWindow;
    const state = component.inboundRadarProof.read();
    return { displayMode: state.displayMode, selectedView: state.selectedView, views: state.views, radarSelected: component.document.getElementById('view-radar').getAttribute('aria-selected'), hostMode: window.radarDisplayMode, hostState: window.radarSavedState, responses: window.radarDisplayResponses };
  });
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  assert.equal(await frame.locator('#view-flights').getAttribute('aria-selected'), 'true');
  assert.equal(await frame.locator('.card').count(), 4);
  assert.equal(await frame.locator('#pip').isEnabled(), false);
  assert.equal(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await frame.locator('#proof').screenshot({ path: resolve(evidence, `flights-inline${suffix}.png`) });
  await frame.locator('.card').first().click();
  const hostSelected = (await frameRead()).selectedRadarId;
  assert.ok(hostSelected);
  const routeText = await frame.locator('.route').allTextContents();
  assert.ok(routeText.some(text => text.includes('Confirmed route')));
  assert.ok(routeText.some(text => text.includes('Route hint')));
  assert.ok(routeText.some(text => text.includes('Route unavailable')));
  assertions.push('Real fake-engine Featured cards render unknown, generic hint and independently dated confirmed routes without provider labels');
  await page.evaluate(async () => {
    const response = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 800, method: 'tools/call', params: { name: 'get_nearby_flights', arguments: { area: 'preset:chicago', limit: 5 } } }) });
    const result = (await response.json()).result; window.radarLastResult = result;
    document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, location.origin);
  });
  await waitForState(page, () => document.getElementById('radar').contentWindow.document.querySelectorAll('.card').length === 5);
  assert.equal((await frameRead()).positions.length, 39);
  await frame.locator('#refresh').click();
  await waitForState(page, () => document.getElementById('radar').contentWindow.document.querySelectorAll('.card').length === 4);
  assertions.push('Actual MCP limit five renders five Featured cards while Radar retains thirty-nine targets; normal widget refresh returns four');
  await page.evaluate(() => { window.radarBaselineDto = structuredClone(window.radarLastResult.structuredContent); });
  await frame.locator('#view-radar').click();
  for (const health of ['partial', 'stale', 'unavailable', 'ok']) {
    await page.evaluate(health => {
      const dto = { ...structuredClone(window.radarBaselineDto), health };
      delete dto.warning;
      if (health === 'partial') dto.warning = 'Coverage is partial. Available aircraft remain visible.';
      if (health === 'stale') dto.warning = 'Last accepted observations. Motion stopped while updates are delayed.';
      if (health === 'unavailable') {
        dto.radarTargets = []; dto.featuredFlights = []; dto.collectionVersion = null;
        dto.status = 'Current aircraft data is temporarily unavailable.';
        dto.warning = 'Current coverage is unavailable. This does not mean empty sky.';
      }
      document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: dto } }, location.origin);
    }, health);
    await waitForState(page, health => document.getElementById('radar').contentWindow.inboundRadarProof.read().health === health, health);
    if (health === 'partial') { assert.equal((await frameRead()).positions.length, 39); assert.match(await frame.locator('#board-notice').innerText(), /coverage|limited/i); }
    if (health === 'stale') {
      const before = (await frameRead()).displayPositions;
      assert.ok(before.every(position => position.stopped));
      await advance(1_000);
      assert.deepEqual((await frameRead()).displayPositions, before);
      assert.match(await frame.locator('#board-notice').innerText(), /stopped|delayed/i);
      await frame.locator('#proof').screenshot({ path: resolve(evidence, `radar-health-stale${suffix}.png`) });
    }
    if (health === 'unavailable') {
      assert.equal((await frameRead()).positions.length, 0);
      assert.equal(await frame.locator('.aircraft-marker').count(), 0);
      assert.match(await frame.locator('#board-notice').innerText(), /not.*empty sky/i);
      await frame.locator('#proof').screenshot({ path: resolve(evidence, `radar-health-unavailable${suffix}.png`) });
    }
  }
  assertions.push('MOCK ONLY: Valid safe DTO health variants render partial coverage, stopped stale positions and unavailable coverage rather than empty sky');
  await frame.locator('#view-flights').click();
  displayTransitions.push({ at: 'before-declined-fullscreen', state: await displayState() });
  const declinedResponses = await page.evaluate(() => window.radarDisplayResponses.length);
  await frame.locator('#fullscreen').click();
  // The initial inline state is not an acknowledgment of a declined request.
  // Await the actual mocked reply before changing the host's acceptance policy.
  await waitForState(page, before => window.radarDisplayResponses.length > before, declinedResponses);
  assert.equal(await page.evaluate(() => window.radarDisplayResponses.at(-1).granted), 'inline');
  assert.equal((await frameRead()).displayMode, 'inline');
  displayTransitions.push({ at: 'after-declined-fullscreen', state: await displayState() });
  await page.evaluate(() => {
    window.radarAcceptDisplay = true;
    const frame = document.getElementById('radar'); frame.style.width = '1120px'; frame.style.height = '1120px'; frame.style.border = '0';
  });
  displayTransitions.push({ at: 'before-accepted-fullscreen', state: await displayState() });
  const acceptedResponses = await page.evaluate(() => window.radarDisplayResponses.length);
  await frame.locator('#fullscreen').click();
  await waitForState(page, before => window.radarDisplayResponses.length > before, acceptedResponses);
  assert.equal(await page.evaluate(() => window.radarDisplayResponses.at(-1).granted), 'fullscreen');
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().displayMode === 'fullscreen');
  displayTransitions.push({ at: 'after-accepted-fullscreen', state: await displayState() });
  assert.equal(await frame.locator('#view-radar').getAttribute('aria-selected'), 'true');
  assert.equal((await frameRead()).selectedRadarId, hostSelected);
  assert.equal(await frame.locator('#pip').isEnabled(), false);
  const beforeDisabledPip = await page.evaluate(() => window.radarMessages.filter(method => method === 'ui/request-display-mode').length);
  await frame.locator('#pip').evaluate(node => node.click());
  assert.equal(await page.evaluate(() => window.radarMessages.filter(method => method === 'ui/request-display-mode').length), beforeDisabledPip);
  assert.equal(await frame.locator('#track-flight').isEnabled(), false);
  const desktop = await frame.locator('body').evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, radar: document.getElementById('radar-surface').getBoundingClientRect().toJSON(), summary: document.getElementById('selected').getBoundingClientRect().toJSON() }));
  assert.equal(desktop.overflow, false); assert.ok(desktop.radar.height >= 420);
  assert.ok(desktop.radar.width > desktop.summary.width * 2);
  await assertLabels(frame, 8, hostSelected);
  await frame.locator('#proof').screenshot({ path: resolve(evidence, `radar-expanded${suffix}.png`) });
  assertions.push('MOCK ONLY: Declined fullscreen stays inline; accepted fullscreen defaults Radar, preserves selection, and PiP remains capability-gated disabled');

  await page.evaluate(() => { const frame = document.getElementById('radar'); frame.style.width = '375px'; frame.style.height = '1500px'; });
  await waitForState(page, () => document.getElementById('radar').contentWindow.innerWidth === 375);
  const mobile = await frame.locator('body').evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, radar: document.getElementById('radar-surface').getBoundingClientRect().toJSON(), markers: [...document.querySelectorAll('.aircraft-marker')].map(node => ({ radarId: node.dataset.radarId, label: node.getAttribute('aria-label'), ...node.getBoundingClientRect().toJSON() })) }));
  assert.equal(mobile.overflow, false); assert.ok(mobile.radar.width <= 375 && mobile.radar.height >= 300);
  assert.equal(mobile.markers.length, 39);
  assert.ok(mobile.markers.every(marker => marker.width >= 44 && marker.height >= 44 && marker.label));
  for (const target of mobile.markers) {
    const box = await frame.locator(`.aircraft-marker[data-radar-id="${target.radarId}"]`).boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal((await frameRead()).selectedRadarId, target.radarId, 'Mobile genuine pointer selects the intended glyph');
  }
  await frame.locator(`.aircraft-marker[data-radar-id="${hostSelected}"]`).focus(); await page.keyboard.press('Enter');
  await page.mouse.move(0, 0);
  const mobileLabels = await assertLabels(frame, 5, hostSelected);
  await frame.locator('#proof').screenshot({ path: resolve(evidence, `radar-mobile${suffix}.png`) });
  await frame.locator('#view-flights').click(); assert.equal(await frame.locator('.card').count(), 4);
  assert.equal(await frame.locator('body').evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await frame.locator('#proof').screenshot({ path: resolve(evidence, `flights-mobile${suffix}.png`) });
  assertions.push('375px simulation: All thirty-nine current targets are genuinely pointer-selectable, have 44px accessible targets, at-most-five collision-free labels, four Featured cards and no horizontal overflow');
  await frame.locator('#view-radar').click();
  await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame.parentFrame() !== null }), page.locator('#remount').click()]);
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  assert.equal((await frameRead()).selectedRadarId, hostSelected);
  assert.equal((await frameRead()).selectedView, 'radar');
  assertions.push('MOCK ONLY: OpenAI widget-state adapter preserves selection and view across a simulated remount');

  // Hold the accepted fix so expiry is a local safety boundary, not random marker movement.
  await frame.locator('#pause').click();
  const savedSelected = (await frameRead()).selectedRadarId;
  const beforeExpiryCalls = stats.toolCalls;
  await jump(126_000);
  assert.equal(await frame.locator('.aircraft-marker').count(), 0);
  assert.equal(await frame.locator('.card').count(), 0);
  assert.equal((await frameRead()).selectedRadarId, savedSelected);
  assert.match(await frame.locator('#selected-age').innerText(), /expired/i);
  assert.equal(stats.toolCalls, beforeExpiryCalls);
  assertions.push('Expired selected observations disappear safely but retain an explicit expired panel and original selection; paused polling makes no requests');
  await page.locator('#teardown').click(); await waitForState(page, () => window.radarTeardownAcknowledged);
  const teardownCalls = stats.toolCalls; await jump(21_000); assert.equal(stats.toolCalls, teardownCalls);
  assertions.push('MOCK ONLY: Standard teardown is acknowledged and terminates polling');
  assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
  const result = { ok: true, compiled, scope: 'Local actual engine/MCP/widget; explicitly simulated host messages only', actualChatGptVerified: false, realPipVerified: false, inventedAircraft: initial.positions.length, overlappingCenters, assertions, motionSamples, displayTransitions, desktopLabels, ordLabels, mdwLabels, mobileLabels, desktop, mobile, externalRequests, errors, mcpRequests: stats.toolCalls };
  writeFileSync(resolve(evidence, `browser-proof${suffix}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, compiled, assertions: assertions.length, inventedAircraft: initial.positions.length, externalRequests, errors, actualChatGptVerified: false, output: resolve(evidence, `browser-proof${suffix}.json`) }));
} catch (error) {
  const state = await page?.evaluate(() => {
    const read = window.inboundRadarProof?.read() || document.getElementById('radar')?.contentWindow.inboundRadarProof?.read();
    return { component: read && { views: read.views, selectedView: read.selectedView, displayMode: read.displayMode, hostReady: read.hostReady, paused: read.paused }, hostState: window.radarSavedState, hostMode: window.radarDisplayMode };
  }).catch(() => null);
  console.error(JSON.stringify({ ok: false, compiled, passedAssertions: assertions.length, lastPassed: assertions.at(-1), externalRequests, errors, error: String(error), state, displayTransitions }));
  throw error;
} finally {
  await browser?.close();
  for (const handle of [harness, server]) if (handle) { handle.closeAllConnections(); await new Promise(resolve => handle.close(resolve)); }
  await dispose?.();
  process.env = previousEnvironment;
  restoreClock();
}
