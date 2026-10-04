import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createRadarProofServer } from '../src/lib/plugin-v1/radar-proof-server.ts';
import { installTestClock } from './test-clock.mjs';

const expectGap = process.argv.includes('--expect-gap');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const evidenceDirectory = resolve('docs/plugin-v1/verification/part-3b3');
mkdirSync(evidenceDirectory, { recursive: true });
let simulationNow = Date.parse('2026-10-04T09:00:00.000Z');
const restoreClock = installTestClock(() => simulationNow);
let server, harness, browser, dispose, stats, service;

const harnessHtml = `<!doctype html><html><body>
<iframe id="radar" src="/widget" style="width:680px;height:790px"></iframe>
<script>
window.radarSavedState={};window.radarLastResult=null;window.radarScriptedResults=[];window.radarToolArguments=[];
const frame=()=>document.getElementById('radar');
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow||event.data?.jsonrpc!=='2.0'||!event.data.method)return;
 const m=event.data;let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'TRANSIENT PROOF',version:'0'},hostCapabilities:{},hostContext:{displayMode:'inline',availableDisplayModes:['inline','fullscreen']}};
 else if(m.method==='tools/call'){
  window.radarToolArguments.push(structuredClone(m.params.arguments));
  if(window.radarScriptedResults.length)result=structuredClone(window.radarScriptedResults.shift());
  else{
   const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:m.id,method:'tools/call',params:m.params})});
   result=(await response.json()).result;
  }
  window.radarLastResult=structuredClone(result);
 }
 else return;
 event.source.postMessage({jsonrpc:'2.0',id:m.id,result},event.origin);
});
Object.defineProperty(frame().contentWindow,'openai',{value:{
 get widgetState(){return window.radarSavedState},
 setWidgetState(state){window.radarSavedState=structuredClone(state)}
}});
</script></body></html>`;

const waitFor = async (page, predicate, argument) => {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    if (await page.evaluate(predicate, argument)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${String(predicate)}`);
};

try {
  ({ server, dispose, stats, service } = await createRadarProofServer({ clock: () => simulationNow }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = `http://127.0.0.1:${server.address().port}`;
  harness = createServer(async (request, response) => {
    if (request.url === '/harness') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(harnessHtml); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(root + (request.url || '/'), { method: request.method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') || 'text/plain' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  harness.listen(0, '127.0.0.1'); await once(harness, 'listening');
  const harnessRoot = `http://127.0.0.1:${harness.address().port}`;
  browser = await chromium.launch({ ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}), headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--in-process-gpu', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.clock.install({ time: new Date(simulationNow) });
  await page.clock.pauseAt(new Date(simulationNow));
  const advanceTo = async at => { const elapsed = at - simulationNow; simulationNow = at; await page.clock.runFor(elapsed); };
  const read = () => page.evaluate(() => document.getElementById('radar').contentWindow.inboundRadarProof.read());
  const capture = async label => {
    const value = await read();
    const directional = value.positions.filter(target => target.groundTrackDeg !== null && target.groundspeedKt > 0).slice(0, 3);
    return { label, at: new Date(simulationNow).toISOString(), frameCount: value.frameCount, animationScheduled: value.animationScheduled,
      pollScheduled: value.pollScheduled, refreshInFlight: value.refreshInFlight, refreshCalls: value.refreshCalls,
      collectionVersion: value.collectionVersion, generatedAt: value.generatedAt,
      aircraft: directional.map(target => { const display = value.displayPositions.find(candidate => candidate.radarId === target.radarId); return {
        radarId: target.radarId, observedAt: target.observedAt, liveAge: (simulationNow - Date.parse(target.observedAt)) / 1000,
        extrapolatedSeconds: display?.extrapolatedSeconds, stopped: display?.stopped,
      }; }), nextPollAt: value.nextPollAt, requestGeneration: value.requestGeneration,
      activeRequestGeneration: value.activeRequestGeneration, acceptedResults: value.acceptedResults,
      rejectedResults: value.rejectedResults, lastRejectedReason: value.lastRejectedReason,
      selectedRadarId: value.selectedRadarId, requestedAreaId: value.requestedAreaId, areaId: value.areaId, health: value.health,
      nextPollKind: value.nextPollKind, shortRetryUsed: value.shortRetryUsed, shortRetrySchedules: value.shortRetrySchedules,
      shortRetryFires: value.shortRetryFires, pollTimers: value.pollTimers, ageTimers: value.ageTimers };
  };

  await page.goto(harnessRoot + '/harness');
  await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
  const frame = page.frameLocator('#radar');
  await frame.locator('#view-radar').click();
  const initialCalls = (await read()).refreshCalls;
  await frame.locator('#refresh').click();
  await waitFor(page, before => {
    const state = document.getElementById('radar').contentWindow.inboundRadarProof.read();
    return state.refreshCalls > before && !state.refreshInFlight;
  }, initialCalls);
  const clientT0 = simulationNow;
  const armed = await capture('T+0 client deadline armed');
  assert.equal(armed.nextPollAt, clientT0 + 20_000);

  await advanceTo(clientT0 + 800);
  await page.evaluate(publicationAt => {
    const result = structuredClone(window.radarLastResult), content = result.structuredContent;
    content.collectionVersion += 1; content.generatedAt = new Date(publicationAt).toISOString();
    for (const target of content.radarTargets) {
      target.observedAt = new Date(publicationAt).toISOString();
      target.freshness = { ageSeconds: 0, state: 'fresh' };
    }
    for (const card of content.featuredFlights) {
      const target = content.radarTargets.find(candidate => candidate.radarId === card.radarId);
      if (target) card.freshness = structuredClone(target.freshness);
    }
    window.radarPublished = structuredClone(result);
    document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, location.origin);
  }, simulationNow);
  await waitFor(page, version => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === version, armed.collectionVersion + 1);
  const published = await capture('T+0.8 fresh collection published without changing client deadline');
  assert.equal(published.nextPollAt, clientT0 + 20_000);

  await page.evaluate(retryAt => {
    const same = structuredClone(window.radarPublished), fresh = structuredClone(window.radarPublished);
    fresh.structuredContent.collectionVersion += 1; fresh.structuredContent.generatedAt = new Date(retryAt).toISOString();
    for (const target of fresh.structuredContent.radarTargets) {
      target.observedAt = new Date(retryAt).toISOString(); target.freshness = { ageSeconds: 0, state: 'fresh' };
    }
    for (const card of fresh.structuredContent.featuredFlights) {
      const target = fresh.structuredContent.radarTargets.find(candidate => candidate.radarId === card.radarId);
      if (target) card.freshness = structuredClone(target.freshness);
    }
    window.radarScriptedResults.push(same, fresh);
  }, clientT0 + 23_000);

  await advanceTo(clientT0 + 19_000);
  const selectionDeadline19 = (await read()).nextPollAt;
  const selectionIds = (await read()).positions.filter(target => target.groundTrackDeg !== null && target.groundspeedKt > 0).slice(0, 2).map(target => target.radarId);
  await frame.locator(`.aircraft-marker[data-radar-id="${selectionIds[0]}"]`).click({ force: true });
  const selectionAt19 = await capture('T+19 selection leaves the imminent deadline unchanged');
  assert.equal(selectionAt19.nextPollAt, selectionDeadline19);
  await advanceTo(clientT0 + 20_000);
  await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, published.refreshCalls);
  const sameAtTwenty = await capture('T+20 same collection returned just before backend eligibility');
  await advanceTo(clientT0 + 22_900);
  const beforeRetry = await capture('T+22.9 before bounded retry');
  await advanceTo(clientT0 + 23_100);
  const afterRetry = await capture('T+23.1 retry opportunity');
  await advanceTo(clientT0 + 24_000);
  const selectionDeadline24 = (await read()).nextPollAt;
  await frame.locator(`.aircraft-marker[data-radar-id="${selectionIds[1]}"]`).click({ force: true });
  const selectionAt24 = await capture('T+24 selection leaves the fresh normal deadline unchanged');
  assert.equal(selectionAt24.nextPollAt, selectionDeadline24);
  const framesBeforeBound = afterRetry.frameCount;
  await advanceTo(clientT0 + 25_900);
  const afterBound = await capture('T+25.9 motion boundary');
  const remainingScriptedResults = await page.evaluate(() => window.radarScriptedResults.length);

  if (expectGap) {
    assert.equal(afterRetry.collectionVersion, published.collectionVersion, 'Baseline has no retry before the motion cap');
    assert.ok(afterBound.aircraft.every(target => target.stopped && target.extrapolatedSeconds === 25));
    assert.ok(afterBound.frameCount > framesBeforeBound, 'RAF continues while the visible trajectories are capped');
    assert.equal(afterBound.animationScheduled, true);
    assert.equal(remainingScriptedResults, 1, 'The backend-fresh retry result remains unused');
  } else {
    assert.equal(afterRetry.collectionVersion, published.collectionVersion + 1, 'One short retry accepts the now-eligible collection');
    assert.ok(afterBound.aircraft.every(target => !target.stopped && target.extrapolatedSeconds < 3));
    assert.ok(afterBound.frameCount > framesBeforeBound);
    assert.equal(afterBound.animationScheduled, true);
    assert.equal(remainingScriptedResults, 0);
    assert.equal(afterBound.pollTimers.maxPending, 1);
    assert.equal(afterBound.ageTimers.maxPending, 1);
  }
  let boundedSameRetry = null, hostLike65Seconds = null;
  if (!expectGap) {
    const freshResult = await page.evaluate(() => structuredClone(window.radarLastResult));
    await advanceTo(clientT0 + 26_000);
    await page.evaluate(result => { window.radarScriptedResults.push(result); }, freshResult);
    const youngRetrySchedules = (await read()).shortRetrySchedules;
    await frame.locator('#refresh').click();
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, afterBound.refreshCalls);
    const youngSame = await capture('Same version with young anchors keeps normal cadence');
    assert.equal(youngSame.shortRetrySchedules, youngRetrySchedules);
    assert.equal(youngSame.nextPollKind, 'normal');

    await advanceTo(youngSame.nextPollAt - 100);
    await page.evaluate(result => { window.radarScriptedResults.push(result); }, freshResult);
    await advanceTo(youngSame.nextPollAt);
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, youngSame.refreshCalls);
    const nearSame = await capture('Same version near the cap schedules exactly one short retry');
    assert.equal(nearSame.shortRetrySchedules, youngRetrySchedules + 1);
    assert.equal(nearSame.nextPollKind, 'short-retry');
    await page.evaluate(result => { window.radarScriptedResults.push(result); }, freshResult);
    await advanceTo(nearSame.nextPollAt + 100);
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, nearSame.refreshCalls);
    const retryStillSame = await capture('Short retry still same returns to bounded normal cadence');
    assert.equal(retryStillSame.shortRetrySchedules, nearSame.shortRetrySchedules);
    assert.equal(retryStillSame.nextPollKind, 'normal');
    assert.ok(retryStillSame.nextPollAt - simulationNow >= 19_900);
    const callsAfterBoundedRetry = retryStillSame.refreshCalls;
    await advanceTo(simulationNow + 5_000);
    assert.equal((await read()).refreshCalls, callsAfterBoundedRetry, 'No rapid loop follows the one bounded retry');
    boundedSameRetry = { youngSame, nearSame, retryStillSame, callsFiveSecondsLater: (await read()).refreshCalls };

    await page.goto(harnessRoot + '/harness');
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof?.read().hostReady);
    const hostFrame = page.frameLocator('#radar');
    await hostFrame.locator('#view-radar').click();
    const hostT0 = simulationNow;
    const initialHost = await read();
    const initialDeadline = initialHost.nextPollAt;
    assert.equal(initialDeadline, hostT0 + 20_000);
    const rpc = async area => {
      const response = await fetch(root + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(simulationNow), method: 'tools/call', params: { name: 'get_nearby_flights', arguments: { area, limit: 4 } } }) });
      return (await response.json()).result;
    };
    const synthetic = (template, source, version, observedAt, generatedAt) => {
      const result = structuredClone(template), content = result.structuredContent, sourceContent = source?.structuredContent;
      content.collectionVersion = version; content.generatedAt = new Date(generatedAt).toISOString();
      const anchors = new Map((sourceContent?.radarTargets || content.radarTargets).map(target => [target.radarId, target]));
      for (const target of content.radarTargets) {
        const anchor = anchors.get(target.radarId) || target;
        for (const key of ['latitude', 'longitude', 'altitudeFt', 'groundspeedKt', 'groundTrackDeg', 'verticalRateFpm', 'positionKind', 'motion']) target[key] = structuredClone(anchor[key]);
        target.observedAt = new Date(observedAt).toISOString();
        const ageSeconds = Math.max(0, (generatedAt - observedAt) / 1000);
        target.freshness = { ageSeconds, state: ageSeconds <= 45 ? 'fresh' : 'stale' };
      }
      for (const card of content.featuredFlights) {
        const target = content.radarTargets.find(candidate => candidate.radarId === card.radarId);
        if (target) { card.altitudeFt = target.altitudeFt; card.motion = structuredClone(target.motion); card.freshness = structuredClone(target.freshness); }
      }
      return result;
    };
    const queue = result => page.evaluate(value => { window.radarScriptedResults.push(value); }, result);
    const notifyResult = result => page.evaluate(value => {
      document.getElementById('radar').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: value }, location.origin);
    }, result);
    const timeline = [];
    const hostCapture = async label => { const sample = await capture(label); timeline.push(sample); return sample; };
    const advanceHostTo = async offset => { await advanceTo(hostT0 + offset); };
    const select = async radarId => { await hostFrame.locator(`.aircraft-marker[data-radar-id="${radarId}"]`).click({ force: true }); await waitFor(page, id => document.getElementById('radar').contentWindow.inboundRadarProof.read().selectedRadarId === id, radarId); };

    await advanceHostTo(800);
    let currentResult = synthetic(await rpc('preset:chicago'), null, 100, simulationNow, simulationNow);
    await notifyResult(currentResult);
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === 100);
    const published65 = await hostCapture('T+0.8 publication');
    assert.equal(published65.nextPollAt, initialDeadline);
    const movingIds = (await read()).positions.filter(target => target.groundTrackDeg !== null && target.groundspeedKt > 0).slice(0, 4).map(target => target.radarId);
    assert.equal(movingIds.length, 4);

    await advanceHostTo(5_000); await select(movingIds[0]);
    const selectedA = await hostCapture('T+5 select aircraft A'); assert.equal(selectedA.nextPollAt, initialDeadline);
    await advanceHostTo(12_000); await select(movingIds[1]);
    const selectedB = await hostCapture('T+12 select aircraft B'); assert.equal(selectedB.nextPollAt, initialDeadline);

    await advanceHostTo(18_000);
    await queue(synthetic(await rpc('airport:KORD'), currentResult, 100, hostT0 + 800, simulationNow));
    await hostFrame.locator('#area').selectOption('airport:KORD');
    await waitFor(page, () => { const state = document.getElementById('radar').contentWindow.inboundRadarProof.read(); return state.areaId === 'airport:KORD' && !state.refreshInFlight; });
    const ord = await hostCapture('T+18 Chicago to ORD'); assert.equal(ord.nextPollAt, initialDeadline);

    await queue(synthetic(await rpc('airport:KORD'), currentResult, 100, hostT0 + 800, hostT0 + 20_000));
    await advanceHostTo(20_000);
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, ord.refreshCalls);
    const same20 = await hostCapture('T+20 same-version cadence edge');
    assert.equal(same20.nextPollKind, 'short-retry'); assert.equal(same20.nextPollAt, hostT0 + 23_000);

    await advanceHostTo(22_900);
    currentResult = synthetic(await rpc('airport:KORD'), null, 101, hostT0 + 23_000, hostT0 + 23_000);
    await queue(currentResult);
    await advanceHostTo(23_100);
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === 101);
    const fresh23 = await hostCapture('T+23 bounded retry accepts fresh version');
    assert.equal(fresh23.nextPollKind, 'normal'); assert.ok(fresh23.aircraft.every(target => !target.stopped));

    await advanceHostTo(27_000); await select(movingIds[2]);
    const selectedC = await hostCapture('T+27 select aircraft C'); assert.equal(selectedC.nextPollAt, fresh23.nextPollAt);
    await advanceHostTo(34_000);
    await queue(synthetic(await rpc('airport:KMDW'), currentResult, 101, hostT0 + 23_000, simulationNow));
    await hostFrame.locator('#area').selectOption('airport:KMDW');
    await waitFor(page, () => { const state = document.getElementById('radar').contentWindow.inboundRadarProof.read(); return state.areaId === 'airport:KMDW' && !state.refreshInFlight; });
    const mdw = await hostCapture('T+34 ORD to MDW'); assert.equal(mdw.nextPollAt, fresh23.nextPollAt);

    await advanceHostTo(42_000);
    await queue(synthetic(await rpc('airport:KMDW'), currentResult, 101, hostT0 + 23_000, simulationNow));
    await hostFrame.locator('#refresh').click();
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, mdw.refreshCalls);
    const manual = await hostCapture('T+42 manual Refresh');
    assert.equal(manual.nextPollKind, 'short-retry'); assert.equal(manual.nextPollAt, hostT0 + 45_000);

    await advanceHostTo(44_900);
    currentResult = synthetic(await rpc('airport:KMDW'), null, 102, hostT0 + 45_000, hostT0 + 45_000);
    await queue(currentResult); await advanceHostTo(45_100);
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === 102);
    const fresh45 = await hostCapture('T+45 manual bounded retry accepts fresh version');
    await advanceHostTo(48_000); await select(movingIds[3]);
    const selectedD = await hostCapture('T+48 select aircraft D'); assert.equal(selectedD.nextPollAt, fresh45.nextPollAt);

    await advanceTo(fresh45.nextPollAt - 100);
    currentResult = synthetic(await rpc('airport:KMDW'), null, 103, fresh45.nextPollAt, fresh45.nextPollAt);
    await queue(currentResult); await advanceTo(fresh45.nextPollAt + 100);
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === 103);
    const final65 = await hostCapture('T+65 normal cadence accepts fresh version');
    assert.ok(simulationNow - hostT0 >= 65_000);
    assert.ok(timeline.every(sample => sample.animationScheduled));
    assert.ok(timeline.every(sample => !sample.aircraft.length || sample.aircraft.some(target => !target.stopped)));
    assert.equal(final65.pollTimers.maxPending, 1); assert.equal(final65.ageTimers.maxPending, 1);
    assert.deepEqual(timeline.filter(sample => /fresh version/.test(sample.label) || /publication|normal cadence/.test(sample.label)).map(sample => sample.collectionVersion), [100, 101, 102, 103]);

    await hostFrame.locator('#pause').click();
    const stoppedAnchor = (await read()).positions.find(target => target.radarId === movingIds[0]);
    await advanceTo(Date.parse(stoppedAnchor.observedAt) + 25_100);
    const genuinelyStopped = await hostCapture('Backend stopped: unchanged fix reaches the 25-second safety cap');
    const stoppedDisplay = genuinelyStopped.aircraft.find(target => target.radarId === movingIds[0]);
    assert.equal(stoppedDisplay.extrapolatedSeconds, 25); assert.equal(stoppedDisplay.stopped, true);
    assert.equal(genuinelyStopped.animationScheduled, true);
    hostLike65Seconds = { durationMs: simulationNow - hostT0, timeline, safetyCap: genuinelyStopped,
      authoritativeVersions: [100, 101, 102, 103], meaningfulDeadlineUnchangedBySelections: true,
      maxPendingRaf: 1, maxPendingPollTimers: final65.pollTimers.maxPending, maxPendingAgeTimers: final65.ageTimers.maxPending };
  }

  const diagnostics = service.diagnostics();
  assert.equal(diagnostics.providerApiCalls, 0); assert.equal(diagnostics.productionApiCalls, 0); assert.equal(diagnostics.productionDbAccess, 0);
  const result = { ok: true, expected: expectGap ? 'baseline-gap' : 'bounded-retry-fix', policyTimeline: {
    clientDeadlineArmedAt: new Date(clientT0).toISOString(), publicationAt: new Date(clientT0 + 800).toISOString(),
    scheduledRequestAt: new Date(clientT0 + 20_000).toISOString(), retryOpportunityAt: new Date(clientT0 + 23_000).toISOString(),
    originalMotionCapAt: new Date(clientT0 + 25_800).toISOString(),
  }, captures: [armed, published, selectionAt19, sameAtTwenty, beforeRetry, afterRetry, selectionAt24, afterBound], remainingScriptedResults,
    boundedSameRetry, hostLike65Seconds, isolation: { aviationProviderCalls: stats.aviationProviderCalls, productionApiCalls: stats.productionApiCalls,
      productionDbAccess: stats.productionDbAccess, serviceProviderApiCalls: diagnostics.providerApiCalls,
      serviceProductionApiCalls: diagnostics.productionApiCalls, serviceProductionDbAccess: diagnostics.productionDbAccess } };
  const output = resolve(evidenceDirectory, expectGap ? 'transient-gap-before-fix.json' : 'transient-gap-after-fix.json');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, expected: result.expected, output, finalVersion: afterBound.collectionVersion,
    rafAdvancedAtCap: afterBound.frameCount > framesBeforeBound, allStoppedAtCap: afterBound.aircraft.every(target => target.stopped) }));
} finally {
  await browser?.close();
  for (const handle of [harness, server]) if (handle) { handle.closeAllConnections(); await new Promise(resolveClose => handle.close(resolveClose)); }
  await dispose?.(); restoreClock();
}
