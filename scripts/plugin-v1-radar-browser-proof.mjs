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
const handoff = process.argv.includes('--part-3b4');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const evidence = resolve(`docs/plugin-v1/verification/${handoff ? 'part-3b4' : 'part-3b3'}`);
const suffix = compiled ? '-compiled' : '';
mkdirSync(evidence, { recursive: true });
let simulationNow = Date.parse('2026-10-04T03:00:06Z');
const restoreClock = installTestClock(() => simulationNow);
const previousEnvironment = process.env;
const assertions = [];
const errors = [];
const displayTransitions = [];
let hostLifecycle;
let lifecycleSteps;
let externalRequests = 0;
let server, harness, browser, page, stats, root, dispose;

const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>SIMULATED HOST — not ChatGPT</title></head><body>
<h1>SIMULATED HOST — not ChatGPT</h1><p>Component messages only. No real PiP or ChatGPT host approval is claimed.</p>
<button id="remount">Remount component</button><button id="teardown">Send simulated teardown</button>
<iframe id="radar" title="Invented Radar component" src="/widget" style="width:680px;height:790px;border:1px solid #ddd"></iframe>
<script>
window.radarSavedState={};window.radarMessages=[];window.radarTeardownAcknowledged=false;
window.radarSetWidgetStateCalls=0;window.radarGlobalsEvents=0;window.radarGlobalsBudget=0;
window.radarRetainedToolOutput=null;window.radarLastResult=null;window.radarToolArguments=[];
window.radarHoldTools=false;window.radarHeldToolReplies=[];
window.radarDisplayResponses=[];
window.radarModes=['inline','fullscreen'];window.radarDisplayMode='inline';window.radarAcceptDisplay=false;
const frame=()=>document.getElementById('radar');
window.radarPersistWidgetState=(state,component)=>{
 window.radarSetWidgetStateCalls++;
 const snapshot=structuredClone(state),changed=JSON.stringify(snapshot)!==JSON.stringify(window.radarSavedState);
 window.radarSavedState=snapshot;
 if(changed&&window.radarGlobalsBudget>0){
  window.radarGlobalsBudget--;
  queueMicrotask(()=>{window.radarGlobalsEvents++;component.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:structuredClone(snapshot),toolOutput:window.radarRetainedToolOutput}}}));});
 }
};
window.radarReleaseTool=index=>{const held=window.radarHeldToolReplies.splice(index,1)[0];if(held)held.reply();};
window.radarReleaseTools=()=>{window.radarHoldTools=false;for(const held of window.radarHeldToolReplies.splice(0))held.reply();};
document.getElementById('remount').onclick=()=>{frame().src='/widget';};
document.getElementById('teardown').onclick=()=>{frame().contentWindow.postMessage({jsonrpc:'2.0',id:777,method:'ui/resource-teardown',params:{reason:'simulated session ended'}},location.origin);};
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow || event.data?.jsonrpc!=='2.0')return;
 const m=event.data;if(m.id===777&&m.result){window.radarTeardownAcknowledged=true;return;}
 if(!m.method)return;window.radarMessages.push(m.method);let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'SIMULATED HOST',version:'0'},hostCapabilities:{},hostContext:{displayMode:window.radarDisplayMode,availableDisplayModes:window.radarModes}};
 else if(m.method==='tools/call'){
  window.radarToolArguments.push(structuredClone(m.params.arguments));
  const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:m.id,method:'tools/call',params:m.params})});result=(await response.json()).result;
  window.radarLastResult=result;if(!window.radarRetainedToolOutput)window.radarRetainedToolOutput=structuredClone(result);
  if(window.radarHoldTools)await new Promise(reply=>window.radarHeldToolReplies.push({arguments:structuredClone(m.params.arguments),reply}));
 }
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
  assert.equal(await page.locator('#track-flight').isEnabled(), true);
  assertions.push('Forty invented targets render directional accepted track and a neutral missing-track symbol; exact selectable SYN101 enables explicit Track flight');

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
  const replacementDisplay = replaced.displayPositions.find(target => target.radarId === moving.radarId);
  assert.equal(replacementDisplay.stopped, false, 'A new authoritative fix resumes a target that had reached the 25-second motion bound');
  await advance(500);
  const replacementMoved = (await read()).displayPositions.find(target => target.radarId === moving.radarId);
  assert.notDeepEqual([replacementMoved.latitude, replacementMoved.longitude], [replacementDisplay.latitude, replacementDisplay.longitude], 'The resumed target moves from its new accepted anchor');
  assert.equal(replaced.selectedRadarId, retiring.radarId);
  assert.equal(await locate(page, retiring.radarId).count(), 0);
  assert.match(await page.locator('#selected-age').innerText(), /retained/i);
  await locate(page, moving.radarId).focus(); await page.keyboard.press('Enter');
  assertions.push('A deterministic authoritative update replaces the anchor and resumes bounded motion; the stale retiring target drops out without silently switching its selected panel');
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
  if (handoff) {
    const beforeTrack = await read(), trackDeadline = beforeTrack.nextPollAt;
    await page.locator('#track-flight').click();
    await waitForState(page, () => window.inboundRadarProof.read().handoffMode === 'detail');
    const detail = await read();
    assert.equal(detail.handoffStatus, 'resolved'); assert.equal(detail.nextPollAt, trackDeadline);
    assert.equal(detail.pollTimers.maxPending, 1); assert.equal(detail.ageTimers.maxPending, 1);
    assert.match(await page.locator('#detail-route').innerText(), /ORD.*BOS/);
    await page.locator('#back-radar').click(); assert.equal((await read()).selectedRadarId, moving.radarId);
    assert.equal((await read()).nextPollAt, trackDeadline);
    await page.locator('.aircraft-marker[aria-label^="SYN105,"]').click({ force: true });
    const ambiguityDeadline = (await read()).nextPollAt;
    await page.locator('#track-flight').click();
    await waitForState(page, () => window.inboundRadarProof.read().handoffMode === 'ambiguous');
    assert.equal(await page.locator('.candidate').count(), 2); assert.equal((await read()).nextPollAt, ambiguityDeadline);
    await page.locator('.candidate').first().click(); await waitForState(page, () => window.inboundRadarProof.read().handoffMode === 'detail');
    assert.equal((await read()).handoffStatus, 'resolved'); assert.equal((await read()).nextPollAt, ambiguityDeadline);
    await page.locator('#proof').screenshot({ path: resolve(evidence, `flight-detail${suffix}.png`) });
    await page.locator('#back-radar').click();
    assert.equal((await read()).areaId, 'preset:chicago'); assert.equal((await read()).selectedView, 'radar');
    assertions.push('Explicit SYN101 Track resolves detail; SYN105 exposes two dated choices; Back preserves board/area/view/selection and handoff never resets the poll deadline');
  }

  // Explicitly simulated host messages; no native host/PiP implementation is exercised.
  await page.addInitScript(() => {
    if (window.parent !== window) {
      const requestFrame = window.requestAnimationFrame.bind(window), cancelFrame = window.cancelAnimationFrame.bind(window);
      const requestInterval = window.setInterval.bind(window), cancelInterval = window.clearInterval.bind(window);
      const pending = new Set(), pendingAges = new Set();
      window.radarRafProof = { scheduled: 0, fired: 0, cancelled: 0, pending: 0, maxPending: 0 };
      window.radarAgeTimerProof = { scheduled: 0, fired: 0, cancelled: 0, pending: 0, maxPending: 0 };
      window.requestAnimationFrame = callback => {
        let id = 0;
        id = requestFrame(time => {
          if (pending.delete(id)) window.radarRafProof.pending--;
          window.radarRafProof.fired++;
          callback(time);
        });
        pending.add(id); window.radarRafProof.scheduled++; window.radarRafProof.pending++;
        window.radarRafProof.maxPending = Math.max(window.radarRafProof.maxPending, window.radarRafProof.pending);
        return id;
      };
      window.cancelAnimationFrame = id => {
        if (pending.delete(id)) { window.radarRafProof.pending--; window.radarRafProof.cancelled++; }
        cancelFrame(id);
      };
      window.setInterval = (callback, delay = 0, ...args) => {
        const isAgeTimer = Number(delay) === 1_000;
        let id = 0;
        id = requestInterval((...values) => {
          if (isAgeTimer) window.radarAgeTimerProof.fired++;
          callback(...values);
        }, delay, ...args);
        if (isAgeTimer) {
          pendingAges.add(id); window.radarAgeTimerProof.scheduled++; window.radarAgeTimerProof.pending++;
          window.radarAgeTimerProof.maxPending = Math.max(window.radarAgeTimerProof.maxPending, window.radarAgeTimerProof.pending);
        }
        return id;
      };
      window.clearInterval = id => {
        if (pendingAges.delete(id)) { window.radarAgeTimerProof.pending--; window.radarAgeTimerProof.cancelled++; }
        cancelInterval(id);
      };
      window.openai = {
        get widgetState() { return window.parent.radarSavedState; },
        get toolOutput() { return window.parent.radarRetainedToolOutput; },
        setWidgetState: state => { window.parent.radarPersistWidgetState(state, window); },
      };
    }
  });
  await page.goto(harnessRoot + '/harness');
  const frame = page.frameLocator('#radar');
  const frameRead = () => page.evaluate(() => document.getElementById('radar').contentWindow.inboundRadarProof.read());
  const lifecycleRead = () => page.evaluate(() => {
    const component = document.getElementById('radar').contentWindow;
    return { ...component.inboundRadarProof.read(), raf: { ...component.radarRafProof }, hostAgeTimers: { ...component.radarAgeTimerProof }, stateWrites: window.radarSetWidgetStateCalls, hostEchoEvents: window.radarGlobalsEvents, toolArguments: structuredClone(window.radarToolArguments), hostState: structuredClone(window.radarSavedState) };
  });
  const assertHostMotion = async (radarId, duration = 500) => {
    const before = await lifecycleRead();
    const beforePosition = before.displayPositions.find(target => target.radarId === radarId);
    assert.ok(beforePosition && !beforePosition.stopped, `${radarId} starts from a moving accepted fix`);
    await advance(duration);
    const after = await lifecycleRead();
    const afterPosition = after.displayPositions.find(target => target.radarId === radarId);
    assert.ok(after.frameCount > before.frameCount, 'Host lifecycle leaves RAF frames advancing');
    assert.notDeepEqual([afterPosition.latitude, afterPosition.longitude], [beforePosition.latitude, beforePosition.longitude], 'Host lifecycle leaves the display position moving');
    assert.equal(after.raf.pending, 1, 'Exactly one animation frame remains scheduled');
    assert.equal(after.raf.maxPending, 1, 'No duplicate RAF loop was ever scheduled');
    assert.equal(after.pollTimers.maxPending, 1, 'No duplicate polling timer was ever scheduled');
    assert.equal(after.ageTimers.maxPending, 1, 'No duplicate logical aging interval was ever scheduled');
    assert.equal(after.hostAgeTimers.maxPending, 1, 'No duplicate browser aging interval was ever scheduled');
    return { before, after };
  };
  const lifecycleSnapshot = (state, radarId) => {
    const position = state.displayPositions.find(target => target.radarId === radarId);
    const accepted = state.positions.find(target => target.radarId === radarId);
    return { frameCount: state.frameCount, displayPosition: position && { latitude: position.latitude, longitude: position.longitude, extrapolatedSeconds: position.extrapolatedSeconds, stopped: position.stopped },
      raf: state.raf, pollTimers: state.pollTimers, ageTimers: state.ageTimers, hostAgeTimers: state.hostAgeTimers, pollScheduled: state.pollScheduled, refreshInFlight: state.refreshInFlight, refreshCalls: state.refreshCalls, paused: state.paused, documentHidden: state.documentHidden,
      pageInactive: state.pageInactive, selectedRadarId: state.selectedRadarId, requestedAreaId: state.requestedAreaId, areaId: state.areaId, collectionVersion: state.collectionVersion,
      observedAt: accepted?.observedAt, health: state.health, stateWrites: state.stateWrites, globalsEvents: state.globalsEvents, hostEchoEvents: state.hostEchoEvents,
      hostContextEvents: state.hostContextEvents, nextPollAt: state.nextPollAt, pollScheduleEpoch: state.pollScheduleEpoch };
  };
  const recordHostMotion = async (label, radarId, duration = 500) => {
    const sample = await assertHostMotion(radarId, duration);
    lifecycleSteps.push({ label, before: lifecycleSnapshot(sample.before, radarId), after: lifecycleSnapshot(sample.after, radarId), frameDelta: sample.after.frameCount - sample.before.frameCount });
    return sample;
  };
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

  // Reproduce ChatGPT's full-global state acknowledgment: a local widget-state
  // update is echoed with the retained launch toolOutput. That incoming event
  // must never write state back or regress a newer accepted fix.
  await frame.locator('#view-radar').click();
  const initialRefreshCalls = (await lifecycleRead()).refreshCalls;
  await frame.locator('#refresh').click();
  await waitForState(page, before => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return Boolean(window.radarRetainedToolOutput) && proof.refreshCalls > before && !proof.refreshInFlight;
  }, initialRefreshCalls);
  const hostT0 = simulationNow;
  const launch = await lifecycleRead();
  const hostMoving = launch.positions.find(target => target.groundTrackDeg !== null && target.groundspeedKt > 0);
  assert.ok(hostMoving);
  lifecycleSteps = [];
  await recordHostMotion('T0 moving launch fix', hostMoving.radarId);

  await jump(hostT0 + 5_000 - simulationNow);
  const clickBefore = await lifecycleRead();
  await page.evaluate(() => { window.radarGlobalsBudget = 8; });
  await frame.locator(`.aircraft-marker[data-radar-id="${hostMoving.radarId}"]`).click({ force: true });
  await waitForState(page, before => window.radarGlobalsEvents > before, clickBefore.hostEchoEvents);
  const clickAfter = await lifecycleRead();
  assert.equal(clickAfter.stateWrites - clickBefore.stateWrites, 1, 'One selection creates one host state write with no toolOutput feedback');
  assert.equal(clickAfter.hostEchoEvents - clickBefore.hostEchoEvents, 1);
  assert.equal(clickAfter.globalsEvents - clickBefore.globalsEvents, 1, 'The widget processed one globals event');
  assert.equal(clickAfter.refreshCalls, clickBefore.refreshCalls, 'Selection remains pure UI state');
  assert.equal(clickAfter.collectionVersion, launch.collectionVersion);
  assert.equal(clickAfter.positions.find(target => target.radarId === hostMoving.radarId).observedAt, hostMoving.observedAt);
  await recordHostMotion('T+5 selection and globals echo', hostMoving.radarId);

  await jump(hostT0 + 10_000 - simulationNow);
  const ordBefore = await lifecycleRead();
  await page.evaluate(() => { window.radarGlobalsBudget = 8; window.radarHoldTools = true; });
  await frame.locator('#area').selectOption('airport:KORD');
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  const ordPending = await lifecycleRead();
  assert.equal(ordPending.requestedAreaId, 'airport:KORD');
  assert.equal(ordPending.areaId, 'preset:chicago', 'Old accepted board stays visible while ORD loads');
  assert.equal(ordPending.stateWrites - ordBefore.stateWrites, 1, 'One area choice creates one host state write');
  assert.equal(ordPending.hostEchoEvents - ordBefore.hostEchoEvents, 1);
  assert.equal(ordPending.globalsEvents - ordBefore.globalsEvents, 1);
  assert.equal(ordPending.pollScheduled, false);
  await recordHostMotion('T+10 ORD while tool response is held', hostMoving.radarId);
  await page.evaluate(() => window.radarReleaseTools());
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().areaId === 'airport:KORD');
  const ord = await lifecycleRead();
  assert.equal(ord.requestedAreaId, 'airport:KORD');
  assert.equal(ord.collectionVersion, launch.collectionVersion, 'ORD reprojects the same T0 collection');
  assert.equal(ord.pollScheduled, true);
  await recordHostMotion('ORD accepted and reprojected', hostMoving.radarId);

  const beforeT20Calls = (await lifecycleRead()).refreshCalls;
  const nextAuthoritativeDeadline = (await lifecycleRead()).nextPollAt;
  assert.ok(nextAuthoritativeDeadline > simulationNow, 'ORD retains an armed meaningful refresh deadline');
  await jump(nextAuthoritativeDeadline - simulationNow);
  await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > before, beforeT20Calls);
  let fresh = await lifecycleRead();
  let watchdogAttempts = 0;
  while (fresh.collectionVersion === launch.collectionVersion && watchdogAttempts < 3) {
    assert.ok(['short-retry', 'normal'].includes(fresh.nextPollKind), 'An unchanged result retains one bounded scheduler deadline');
    const sameVersionCalls = fresh.refreshCalls;
    await jump(fresh.nextPollAt - simulationNow);
    await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > before, sameVersionCalls);
    fresh = await lifecycleRead();
    watchdogAttempts++;
  }
  const freshMoving = fresh.positions.find(target => target.radarId === hostMoving.radarId);
  assert.ok(fresh.refreshCalls - beforeT20Calls >= 1 && fresh.refreshCalls - beforeT20Calls <= 4, 'The retained deadline uses at most three bounded watchdog retries');
  assert.ok(fresh.collectionVersion > launch.collectionVersion, 'The retained deadline accepts the next authoritative collection');
  assert.ok(Date.parse(freshMoving.observedAt) > Date.parse(hostMoving.observedAt), 'The retained deadline replaces the authoritative fix');
  assert.ok(fresh.toolArguments.filter(input => input.area === 'airport:KORD').length >= 2, 'ORD has its area load and an authoritative periodic refresh');
  await recordHostMotion('Retained-deadline authoritative fix', hostMoving.radarId);

  const mdwBefore = await lifecycleRead();
  await page.evaluate(() => { window.radarGlobalsBudget = 8; window.radarHoldTools = true; });
  await frame.locator('#area').selectOption('airport:KMDW');
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  const mdwPending = await lifecycleRead();
  assert.equal(mdwPending.requestedAreaId, 'airport:KMDW');
  assert.equal(mdwPending.areaId, 'airport:KORD');
  assert.equal(mdwPending.stateWrites - mdwBefore.stateWrites, 1);
  await recordHostMotion('MDW while tool response is held', hostMoving.radarId);
  await page.evaluate(() => window.radarReleaseTools());
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().areaId === 'airport:KMDW');
  assert.equal((await lifecycleRead()).collectionVersion, fresh.collectionVersion);
  await recordHostMotion('MDW accepted and reprojected', hostMoving.radarId);

  const anotherMoving = (await lifecycleRead()).positions.find(target => target.radarId !== hostMoving.radarId && target.groundTrackDeg !== null && target.groundspeedKt > 0);
  assert.ok(anotherMoving);
  const anotherBefore = await lifecycleRead();
  await page.evaluate(() => { window.radarGlobalsBudget = 8; });
  await frame.locator(`.aircraft-marker[data-radar-id="${anotherMoving.radarId}"]`).click({ force: true });
  await waitForState(page, before => window.radarGlobalsEvents > before, anotherBefore.hostEchoEvents);
  assert.equal((await lifecycleRead()).selectedRadarId, anotherMoving.radarId);
  await recordHostMotion('Unselected aircraft after second selection', hostMoving.radarId);
  await recordHostMotion('New selected aircraft', anotherMoving.radarId);

  await jump(Math.max(0, hostT0 + 26_000 - simulationNow));
  const replayBefore = await lifecycleRead();
  await page.evaluate(() => {
    const component = document.getElementById('radar').contentWindow;
    window.radarGlobalsEvents++;
    component.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { widgetState: structuredClone(window.radarSavedState), toolOutput: structuredClone(window.radarRetainedToolOutput) } } }));
  });
  const replayAfter = await lifecycleRead();
  assert.equal(replayAfter.stateWrites, replayBefore.stateWrites, 'Incoming globals never persist state back to the host');
  assert.equal(replayAfter.hostEchoEvents - replayBefore.hostEchoEvents, 1, 'The simulated host emitted one retained-output echo');
  assert.equal(replayAfter.globalsEvents - replayBefore.globalsEvents, 1, 'The widget processed one retained-output echo');
  assert.equal(replayAfter.rejectedResults - replayBefore.rejectedResults, 1, 'The stale retained launch result is explicitly rejected');
  assert.equal(replayAfter.collectionVersion, fresh.collectionVersion, 'Retained launch toolOutput cannot regress collection version');
  assert.equal(replayAfter.positions.find(target => target.radarId === hostMoving.radarId).observedAt, freshMoving.observedAt, 'Retained launch toolOutput cannot regress observedAt');
  assert.equal(replayAfter.requestedAreaId, 'airport:KMDW');
  await recordHostMotion('Stale retained toolOutput rejected', hostMoving.radarId);

  const coldBefore = await lifecycleRead();
  await page.evaluate(() => {
    const component = document.getElementById('radar').contentWindow;
    const older = structuredClone(window.radarLastResult);
    const cold = structuredClone(older);
    const content = cold.structuredContent;
    const generatedAt = Date.parse(content.generatedAt) + 1_000;
    content.collectionVersion = 1;
    content.generatedAt = new Date(generatedAt).toISOString();
    for (const target of content.radarTargets) {
      target.freshness.ageSeconds = Math.max(0, (generatedAt - Date.parse(target.observedAt)) / 1_000);
      target.freshness.state = target.freshness.ageSeconds <= 45 ? 'fresh' : 'stale';
    }
    for (const featured of content.featuredFlights) {
      const target = content.radarTargets.find(candidate => candidate.radarId === featured.radarId);
      if (target) featured.freshness = structuredClone(target.freshness);
    }
    window.radarColdOlderResult = older;
    window.radarColdNewerResult = cold;
    component.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: cold }, location.origin);
  });
  await waitForState(page, before => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return proof.acceptedResults > before.accepted || proof.rejectedResults > before.rejected;
  }, { accepted: coldBefore.acceptedResults, rejected: coldBefore.rejectedResults });
  const coldAccepted = await lifecycleRead();
  assert.equal(coldAccepted.collectionVersion, 1, `Newer cold-isolate result was rejected: ${coldAccepted.lastRejectedReason}`);
  assert.ok(coldAccepted.latestAcceptedGeneratedAt > coldBefore.latestAcceptedGeneratedAt, 'A newer generatedAt is authoritative across isolates');
  assert.equal(coldAccepted.latestAcceptedVersion, 1, 'A newer cold-isolate version resets the timestamp-local tie-break');
  const coldRejectedBefore = coldAccepted.rejectedResults;
  await page.evaluate(() => {
    const component = document.getElementById('radar').contentWindow;
    const olderHighVersion = structuredClone(window.radarColdOlderResult);
    olderHighVersion.structuredContent.collectionVersion = 999;
    component.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: olderHighVersion }, location.origin);
  });
  await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().rejectedResults > before, coldRejectedBefore);
  const coldAfter = await lifecycleRead();
  assert.equal(coldAfter.collectionVersion, 1, 'An older generatedAt cannot win solely through a higher process-local version');
  assert.equal(coldAfter.latestAcceptedGeneratedAt, coldAccepted.latestAcceptedGeneratedAt);
  await recordHostMotion('Cold-isolate T1/v1 accepted; older T0/v999 rejected', hostMoving.radarId);

  const contextBefore = await lifecycleRead();
  await page.evaluate(() => document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline', availableDisplayModes: ['inline'] } }, location.origin));
  await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().hostContextEvents > before, contextBefore.hostContextEvents);
  assert.equal(await frame.locator('#fullscreen').isEnabled(), false, 'Changed host context removes the fullscreen capability from the control');
  await page.evaluate(() => document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } }, location.origin));
  await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().hostContextEvents >= before + 2, contextBefore.hostContextEvents);
  assert.equal(await frame.locator('#fullscreen').isEnabled(), true, 'Restored host context restores the fullscreen control');
  await recordHostMotion('Host context changed', hostMoving.radarId);
  const contextAfter = await lifecycleRead();
  assert.equal(contextAfter.hostContextEvents - contextBefore.hostContextEvents, 2, 'The widget processed both changed and restored host-context notifications');
  assert.deepEqual(contextAfter.hostContext.availableDisplayModes, ['inline', 'fullscreen']);
  assert.equal(contextAfter.refreshCalls, contextBefore.refreshCalls, 'Host context does not duplicate a refresh');

  const raceBaseline = await lifecycleRead();
  assert.ok(raceBaseline.nextPollAt > simulationNow, 'A future singleton poll deadline is scheduled');
  await page.evaluate(() => { window.radarHoldTools = true; });
  await jump(raceBaseline.nextPollAt - simulationNow);
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  assert.equal(await page.evaluate(() => window.radarHeldToolReplies[0].arguments.area), 'airport:KMDW');
  await frame.locator('#area').selectOption('airport:KORD');
  await waitForState(page, () => window.radarHeldToolReplies.length === 2);
  assert.deepEqual(await page.evaluate(() => window.radarHeldToolReplies.map(held => held.arguments.area)), ['airport:KMDW', 'airport:KORD']);
  await page.evaluate(() => window.radarReleaseTool(1));
  await waitForState(page, () => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return proof.areaId === 'airport:KORD' && proof.requestedAreaId === 'airport:KORD' && proof.pollScheduled;
  });
  const raceNewAccepted = await lifecycleRead();
  const raceToolCount = raceNewAccepted.toolArguments.length;
  await page.evaluate(() => window.radarReleaseTool(0));
  await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > before, raceNewAccepted.refreshCalls);
  const raceOldCompleted = await lifecycleRead();
  assert.equal(raceOldCompleted.areaId, 'airport:KORD', 'A late old-area response cannot replace the new area');
  assert.equal(raceOldCompleted.requestedAreaId, 'airport:KORD');
  assert.equal(raceOldCompleted.nextPollAt, raceNewAccepted.nextPollAt, 'A late old poll cannot replace the new lifecycle deadline');
  assert.equal(raceOldCompleted.pollScheduleEpoch, raceNewAccepted.pollScheduleEpoch, 'A late old poll cannot reschedule the new lifecycle');
  assert.equal(raceOldCompleted.pollScheduled, true);
  await advance(500);
  assert.equal((await lifecycleRead()).toolArguments.length, raceToolCount, 'Out-of-order completion does not create an immediate duplicate poll');
  await page.evaluate(() => window.radarReleaseTools());
  await recordHostMotion('New-area lifecycle survives late old-poll completion', hostMoving.radarId);

  const boundaryBefore = await lifecycleRead();
  assert.ok(boundaryBefore.nextPollAt - simulationNow > 100);
  await jump(boundaryBefore.nextPollAt - simulationNow - 100);
  await page.evaluate(() => { window.radarHoldTools = true; });
  await frame.locator('#area').selectOption('airport:KMDW');
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  const boundaryToolCount = (await lifecycleRead()).toolArguments.length;
  await jump(200);
  assert.equal(await page.evaluate(() => window.radarHeldToolReplies.length), 1, 'The canceled old deadline cannot start a poll while the area refresh is held');
  await page.evaluate(() => window.radarReleaseTool(0));
  await waitForState(page, () => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return proof.areaId === 'airport:KMDW' && proof.pollScheduled;
  });
  const boundaryAccepted = await lifecycleRead();
  assert.ok(boundaryAccepted.nextPollKind === 'short-retry'
    ? boundaryAccepted.nextPollAt - simulationNow >= 2_999
    : boundaryAccepted.nextPollKind === 'normal' && boundaryAccepted.nextPollAt - simulationNow >= 19_999,
  'An area refresh crossing the old deadline arms either the bounded retry or normal cadence');
  await advance(500);
  assert.equal((await lifecycleRead()).toolArguments.length, boundaryToolCount, 'Crossing an expired deadline does not create an immediate duplicate area call');
  await page.evaluate(() => window.radarReleaseTools());
  const resumeBefore = await lifecycleRead();
  await frame.locator('#refresh').click();
  await waitForState(page, before => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return proof.refreshCalls > before && !proof.refreshInFlight;
  }, resumeBefore.refreshCalls);
  const resumedFix = await lifecycleRead();
  const resumedMoving = resumedFix.displayPositions.find(position => {
    const accepted = resumedFix.positions.find(target => target.radarId === position.radarId);
    return !position.stopped && accepted?.groundTrackDeg !== null && accepted?.groundspeedKt > 0;
  });
  assert.ok(resumedMoving, 'The next accepted authoritative fix resumes bounded motion after the scheduling boundary');
  const directionalDisplays = resumedFix.displayPositions.filter(position => {
    const accepted = resumedFix.positions.find(target => target.radarId === position.radarId);
    return accepted?.groundTrackDeg !== null && accepted?.groundspeedKt > 0;
  });
  assert.ok(directionalDisplays.length > 0 && directionalDisplays.every(position => !position.stopped), 'Every directional target in the new fix is moving again');
  const lifecycleMovingRadarId = resumedMoving.radarId;
  await recordHostMotion('New authoritative fix resumes motion after boundary race', lifecycleMovingRadarId);

  await page.evaluate(() => { window.radarHoldTools = true; });
  await frame.locator('#refresh').click();
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  assert.equal(await page.evaluate(() => window.radarHeldToolReplies[0].arguments.area), 'airport:KMDW');
  await frame.locator('#area').selectOption('airport:KORD');
  await waitForState(page, () => window.radarHeldToolReplies.length === 2);
  await page.evaluate(() => window.radarReleaseTool(1));
  await waitForState(page, () => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return proof.areaId === 'airport:KORD' && proof.requestedAreaId === 'airport:KORD' && proof.pollScheduled;
  });
  const manualSuperseded = await lifecycleRead();
  const supersededToolCount = manualSuperseded.toolArguments.length;
  await page.evaluate(() => window.radarReleaseTool(0));
  await waitForState(page, before => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > before, manualSuperseded.refreshCalls);
  const manualLate = await lifecycleRead();
  assert.equal(manualLate.areaId, 'airport:KORD');
  assert.equal(manualLate.nextPollAt, manualSuperseded.nextPollAt, 'A superseded manual continuation cannot reset the newer area deadline');
  assert.equal(manualLate.pollScheduleEpoch, manualSuperseded.pollScheduleEpoch, 'A superseded manual continuation cannot replace the newer scheduler owner');
  assert.equal(manualLate.pollTimers.pending, 1);
  await advance(500);
  assert.equal((await lifecycleRead()).toolArguments.length, supersededToolCount, 'A superseded manual continuation creates no duplicate poll');
  await page.evaluate(() => window.radarReleaseTools());
  await recordHostMotion('New area survives late manual-refresh continuation', lifecycleMovingRadarId);
  assertions.push('MOCK ONLY: newer generatedAt accepts cold-isolate v1, older high versions lose, and overlapping/boundary/superseded area-poll races preserve one poll lifecycle');

  await page.evaluate(() => {
    const component = document.getElementById('radar').contentWindow;
    Object.defineProperty(component.document, 'hidden', { configurable: true, value: true });
    component.document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await lifecycleRead();
  await advance(500);
  const hiddenLater = await lifecycleRead();
  assert.equal(hiddenLater.frameCount, hidden.frameCount);
  assert.equal(hiddenLater.raf.pending, 0);
  assert.equal(hiddenLater.pollScheduled, false);
  assert.equal(hiddenLater.pollTimers.pending, 0);
  assert.equal(hiddenLater.ageTimers.pending, 0);
  assert.equal(hiddenLater.hostAgeTimers.pending, 0);
  assert.equal(hiddenLater.dismissed, false);
  lifecycleSteps.push({ label: 'Visibility hidden stops RAF and polling', before: lifecycleSnapshot(hidden, lifecycleMovingRadarId), after: lifecycleSnapshot(hiddenLater, lifecycleMovingRadarId), frameDelta: hiddenLater.frameCount - hidden.frameCount });
  await page.evaluate(() => {
    window.radarHoldTools = true;
    const component = document.getElementById('radar').contentWindow;
    Object.defineProperty(component.document, 'hidden', { configurable: true, value: false });
    component.document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  await recordHostMotion('Visibility restored before held refresh completes', lifecycleMovingRadarId);
  await page.evaluate(() => window.radarReleaseTools());
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().pollScheduled);

  await page.evaluate(() => document.getElementById('radar').contentWindow.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const pageHidden = await lifecycleRead();
  await advance(500);
  assert.equal((await lifecycleRead()).frameCount, pageHidden.frameCount);
  assert.equal((await lifecycleRead()).dismissed, false, 'A transient pagehide is suspension, not dismissal');
  lifecycleSteps.push({ label: 'Transient pagehide suspends without dismissal', state: lifecycleSnapshot(await lifecycleRead(), lifecycleMovingRadarId) });
  await page.evaluate(() => {
    window.radarHoldTools = true;
    document.getElementById('radar').contentWindow.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await waitForState(page, () => window.radarHeldToolReplies.length === 1);
  await recordHostMotion('Pageshow resumes before held refresh completes', lifecycleMovingRadarId);
  await page.evaluate(() => window.radarReleaseTools());
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().pollScheduled);
  const lifecycleFinal = await lifecycleRead();
  if (handoff && simulationNow < hostT0 + 90_000) {
    await jump(hostT0 + 90_000 - simulationNow);
    await recordHostMotion('T+90 handoff host motion remains live', lifecycleMovingRadarId);
  }
  const finalLifecycleState = await lifecycleRead();
  hostLifecycle = { hostT0, launchVersion: launch.collectionVersion, freshVersion: fresh.collectionVersion, movingRadarId: hostMoving.radarId, finalMovingRadarId: lifecycleMovingRadarId, selectedRadarId: anotherMoving.radarId, steps: lifecycleSteps,
    durationMs: simulationNow - hostT0,
    final: { frameCount: finalLifecycleState.frameCount, raf: finalLifecycleState.raf, stateWrites: finalLifecycleState.stateWrites, globalsEvents: finalLifecycleState.globalsEvents,
      hostEchoEvents: finalLifecycleState.hostEchoEvents, hostContextEvents: finalLifecycleState.hostContextEvents, rejectedResults: finalLifecycleState.rejectedResults,
      refreshCalls: finalLifecycleState.refreshCalls, areaId: finalLifecycleState.areaId, requestedAreaId: finalLifecycleState.requestedAreaId, health: finalLifecycleState.health,
      pollScheduled: finalLifecycleState.pollScheduled, nextPollAt: finalLifecycleState.nextPollAt, pollScheduleEpoch: finalLifecycleState.pollScheduleEpoch } };
  if (handoff) assert.ok(hostLifecycle.durationMs >= 90_000);
  assertions.push('MOCK ONLY: ChatGPT-like globals echo, selection, Chicago/ORD/MDW, T+20 fix, host context, visibility and page lifecycle preserve singleton moving RAF/poll loops without state feedback or stale replay');

  await frame.locator('#area').selectOption('preset:chicago');
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().areaId === 'preset:chicago');
  await frame.locator('#view-flights').click();
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
  await recordHostMotion('Declined fullscreen response', lifecycleMovingRadarId);
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
  await recordHostMotion('Accepted fullscreen response', lifecycleMovingRadarId);
  displayTransitions.push({ at: 'after-accepted-fullscreen', state: await displayState() });
  assert.equal(await frame.locator('#view-radar').getAttribute('aria-selected'), 'true');
  assert.equal((await frameRead()).selectedRadarId, hostSelected);
  assert.equal(await frame.locator('#pip').isEnabled(), false);
  const beforeDisabledPip = await page.evaluate(() => window.radarMessages.filter(method => method === 'ui/request-display-mode').length);
  await frame.locator('#pip').evaluate(node => node.click());
  assert.equal(await page.evaluate(() => window.radarMessages.filter(method => method === 'ui/request-display-mode').length), beforeDisabledPip);
  assert.equal(await frame.locator('#track-flight').isEnabled(), true);
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
  await frame.locator('#area').selectOption('airport:KORD');
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().areaId === 'airport:KORD');
  await Promise.all([page.waitForEvent('framenavigated', { predicate: frame => frame.parentFrame() !== null }), page.locator('#remount').click()]);
  await waitForState(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  await waitForState(page, () => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return proof.requestedAreaId === 'airport:KORD' && proof.areaId === 'airport:KORD';
  });
  assert.equal((await frameRead()).selectedRadarId, hostSelected);
  assert.equal((await frameRead()).selectedView, 'radar');
  assert.equal((await frameRead()).requestedAreaId, 'airport:KORD');
  await recordHostMotion('Persisted-state remount', lifecycleMovingRadarId);
  const remountFinal = await lifecycleRead();
  hostLifecycle.final = lifecycleSnapshot(remountFinal, lifecycleMovingRadarId);
  assertions.push('MOCK ONLY: OpenAI widget-state adapter preserves selection, non-default area, view and one moving RAF loop across a simulated remount');

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
  await frame.locator('#pause').click();
  await waitForState(page, () => {
    const proof = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return !proof.paused && !proof.refreshInFlight && proof.pollTimers.pending === 1 && proof.ageTimers.pending === 1;
  });
  const armedBeforeTeardown = await lifecycleRead();
  assert.equal(armedBeforeTeardown.pollScheduled, true, 'Teardown starts with an armed polling deadline');
  await page.locator('#teardown').click(); await waitForState(page, () => window.radarTeardownAcknowledged);
  const teardown = await lifecycleRead();
  assert.equal(teardown.dismissed, true);
  assert.equal(teardown.raf.pending, 0);
  assert.equal(teardown.pollTimers.pending, 0);
  assert.equal(teardown.ageTimers.pending, 0);
  assert.equal(teardown.hostAgeTimers.pending, 0);
  assert.equal(teardown.pollScheduled, false);
  assert.equal(teardown.ageScheduled, false);
  const teardownCalls = stats.toolCalls, teardownFrames = teardown.frameCount, teardownPollFires = teardown.pollTimers.fired, teardownAgeFires = teardown.ageTimers.fired, teardownHostAgeFires = teardown.hostAgeTimers.fired;
  await jump(21_000);
  const teardownLater = await lifecycleRead();
  assert.equal(stats.toolCalls, teardownCalls);
  assert.equal(teardownLater.frameCount, teardownFrames);
  assert.equal(teardownLater.raf.pending, 0);
  assert.equal(teardownLater.pollTimers.pending, 0);
  assert.equal(teardownLater.ageTimers.pending, 0);
  assert.equal(teardownLater.hostAgeTimers.pending, 0);
  assert.equal(teardownLater.pollTimers.fired, teardownPollFires);
  assert.equal(teardownLater.ageTimers.fired, teardownAgeFires);
  assert.equal(teardownLater.hostAgeTimers.fired, teardownHostAgeFires);
  assertions.push('MOCK ONLY: Standard teardown is acknowledged and terminates RAF, polling and aging timers');
  assert.equal(externalRequests, 0); assert.deepEqual(errors, []);
  const result = { ok: true, compiled, scope: 'Local actual engine/MCP/widget; explicitly simulated host messages only', actualChatGptVerified: false, realPipVerified: false, inventedAircraft: initial.positions.length, overlappingCenters, assertions, motionSamples, hostLifecycle, displayTransitions, desktopLabels, ordLabels, mdwLabels, mobileLabels, desktop, mobile, externalRequests, errors, mcpRequests: stats.toolCalls };
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
