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
const expectWatchdogFreeze = process.argv.includes('--expect-watchdog-freeze');
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
      collectionVersion: value.collectionVersion, generatedAt: value.generatedAt, trajectoryKey: value.trajectoryKey,
      aircraft: directional.map(target => { const display = value.displayPositions.find(candidate => candidate.radarId === target.radarId); return {
        radarId: target.radarId, observedAt: target.observedAt, liveAge: (simulationNow - Date.parse(target.observedAt)) / 1000,
        extrapolatedSeconds: display?.extrapolatedSeconds, stopped: display?.stopped,
      }; }), nextPollAt: value.nextPollAt, requestGeneration: value.requestGeneration,
      activeRequestGeneration: value.activeRequestGeneration, acceptedResults: value.acceptedResults,
      rejectedResults: value.rejectedResults, lastRejectedReason: value.lastRejectedReason,
      selectedRadarId: value.selectedRadarId, requestedAreaId: value.requestedAreaId, areaId: value.areaId, health: value.health,
      nextPollKind: value.nextPollKind, shortRetryUsed: value.shortRetryUsed, shortRetryTrajectoryKey: value.shortRetryTrajectoryKey,
      motionRetryCount: value.motionRetryCount, motionRetryBudgetRemaining: value.motionRetryBudgetRemaining,
      lastMotionRetryAt: value.lastMotionRetryAt, motionCapDeadline: value.motionCapDeadline, shortRetrySchedules: value.shortRetrySchedules,
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
  const published = await capture('T+0 fresh collection clears retry state and arms normal cadence');
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
  let boundedSameRetry = null, hostLike90Seconds = null;
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
    const retryOneStillSame = await capture('First watchdog retry still same schedules the second bounded retry');
    assert.equal(retryOneStillSame.motionRetryCount, 1);
    assert.equal(retryOneStillSame.nextPollKind, 'short-retry');
    assert.ok(retryOneStillSame.nextPollAt - simulationNow >= 3_800);

    await page.evaluate(result => { window.radarScriptedResults.push(result); }, freshResult);
    await advanceTo(retryOneStillSame.nextPollAt + 100);
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, retryOneStillSame.refreshCalls);
    const retryTwoStillSame = await capture('Second watchdog retry still same schedules the final bounded retry');
    assert.equal(retryTwoStillSame.motionRetryCount, 2);
    assert.equal(retryTwoStillSame.nextPollKind, 'short-retry');

    await page.evaluate(result => { window.radarScriptedResults.push(result); }, freshResult);
    await advanceTo(retryTwoStillSame.nextPollAt + 100);
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, retryTwoStillSame.refreshCalls);
    const retryBudgetExhausted = await capture('Third watchdog retry exhausts the bounded budget and returns to normal cadence');
    assert.equal(retryBudgetExhausted.motionRetryCount, 3);
    assert.equal(retryBudgetExhausted.motionRetryBudgetRemaining, 0);
    assert.equal(retryBudgetExhausted.nextPollKind, 'normal');
    assert.ok(retryBudgetExhausted.nextPollAt - simulationNow >= 19_900);
    assert.ok(retryBudgetExhausted.aircraft.every(target => target.extrapolatedSeconds === 25 && target.stopped));
    const callsAfterBoundedRetry = retryBudgetExhausted.refreshCalls;
    await advanceTo(simulationNow + 5_000);
    assert.equal((await read()).refreshCalls, callsAfterBoundedRetry, 'No rapid loop follows the one bounded retry');
    boundedSameRetry = { youngSame, nearSame, retryOneStillSame, retryTwoStillSame, retryBudgetExhausted,
      callsFiveSecondsLater: (await read()).refreshCalls, maximumShortRetriesPerTrajectory: 3 };

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

    let currentResult = synthetic(await rpc('preset:chicago'), null, 100, hostT0, hostT0);
    await notifyResult(currentResult);
    await waitFor(page, () => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === 100);
    const published90 = await hostCapture('T+0 fresh authoritative Chicago board');
    assert.equal(published90.nextPollAt, initialDeadline);
    const movingIds = (await read()).positions.filter(target => target.groundTrackDeg !== null && target.groundspeedKt > 0).slice(0, 4).map(target => target.radarId);
    assert.equal(movingIds.length, 4);

    await advanceHostTo(5_000); await select(movingIds[0]);
    const selectedA = await hostCapture('T+5 select aircraft A'); assert.equal(selectedA.nextPollAt, initialDeadline);
    await advanceHostTo(10_000);
    currentResult = synthetic(await rpc('airport:KORD'), currentResult, 100, hostT0, simulationNow);
    await queue(currentResult);
    await hostFrame.locator('#area').selectOption('airport:KORD');
    await waitFor(page, () => { const state = document.getElementById('radar').contentWindow.inboundRadarProof.read(); return state.areaId === 'airport:KORD' && !state.refreshInFlight; });
    const ord = await hostCapture('T+10 Chicago to ORD with shared trajectory'); assert.equal(ord.nextPollAt, initialDeadline);

    currentResult = synthetic(await rpc('airport:KORD'), currentResult, 100, hostT0, hostT0 + 20_000);
    await queue(currentResult);
    await advanceHostTo(20_000);
    await waitFor(page, calls => document.getElementById('radar').contentWindow.inboundRadarProof.read().refreshCalls > calls, ord.refreshCalls);
    const same20 = await hostCapture('T+20 normal request returns the unchanged trajectory');
    assert.equal(same20.nextPollKind, 'short-retry'); assert.equal(same20.nextPollAt, hostT0 + 23_000);

    await advanceHostTo(22_900);
    currentResult = synthetic(await rpc('airport:KORD'), currentResult, 100, hostT0, hostT0 + 23_000);
    await queue(currentResult);
    await advanceHostTo(23_100);
    await waitFor(page, fires => document.getElementById('radar').contentWindow.inboundRadarProof.read().shortRetryFires > fires, same20.shortRetryFires);
    const same23 = await hostCapture('T+23 first short retry also returns the unchanged trajectory');
    assert.equal(same23.trajectoryKey, published90.trajectoryKey);

    await advanceHostTo(25_100);
    const cap25 = await hostCapture('T+25.1 unchanged trajectory reaches the motion cap');
    assert.ok(cap25.aircraft.every(target => target.extrapolatedSeconds === 25 && target.stopped));
    assert.ok(cap25.frameCount > same23.frameCount, 'RAF must continue while bounded aircraft are stopped');
    assert.equal(cap25.animationScheduled, true);

    let same27 = null;
    if (expectWatchdogFreeze) {
      await advanceHostTo(27_100);
      same27 = await hostCapture('T+27.1 old guard has no second short retry');
      assert.equal(same27.refreshCalls, cap25.refreshCalls);
    } else {
      await advanceHostTo(26_900);
      currentResult = synthetic(await rpc('airport:KORD'), currentResult, 100, hostT0, hostT0 + 27_000);
      await queue(currentResult);
      await advanceHostTo(27_100);
      await waitFor(page, fires => document.getElementById('radar').contentWindow.inboundRadarProof.read().shortRetryFires > fires, same23.shortRetryFires);
      same27 = await hostCapture('T+27 second bounded watchdog retry remains unchanged');
      assert.equal(same27.trajectoryKey, published90.trajectoryKey);
    }

    await advanceHostTo(29_900);
    currentResult = synthetic(await rpc('airport:KMDW'), currentResult, 100, hostT0, hostT0 + 30_000);
    await queue(currentResult);
    await advanceHostTo(30_000);
    await hostFrame.locator('#area').selectOption('airport:KMDW');
    await waitFor(page, () => { const state = document.getElementById('radar').contentWindow.inboundRadarProof.read(); return state.areaId === 'airport:KMDW' && !state.refreshInFlight; });
    const mdw30 = await hostCapture('T+30 ORD to MDW returns the same shared trajectory');
    assert.equal(mdw30.trajectoryKey, published90.trajectoryKey);

    await advanceHostTo(30_500); await select(movingIds[1]);
    const selected30 = await hostCapture('T+30.5 select aircraft immediately after area change');
    assert.ok(selected30.aircraft.every(target => target.extrapolatedSeconds === 25 && target.stopped));
    assert.equal(selected30.animationScheduled, true);
    assert.ok(selected30.frameCount > cap25.frameCount);
    assert.equal(selected30.trajectoryKey, published90.trajectoryKey);
    assert.equal(selected30.nextPollAt, mdw30.nextPollAt, 'selection must not change the meaningful polling deadline');

    if (expectWatchdogFreeze) {
      assert.equal(selected30.shortRetryUsed, true);
      assert.equal(selected30.shortRetryTrajectoryKey, selected30.trajectoryKey);
      assert.ok(selected30.nextPollAt - simulationNow > 10_000, 'old normal deadline is significantly later than the capped trajectory');
      const beforeManualVersion = selected30.collectionVersion;
      currentResult = synthetic(await rpc('airport:KMDW'), null, 101, simulationNow, simulationNow);
      await queue(currentResult);
      await hostFrame.locator('#refresh').click();
      await waitFor(page, version => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === version, 101);
      const manualResume = await hostCapture('T+30.5 manual Refresh accepts a newer trajectory and resumes motion');
      assert.equal(manualResume.collectionVersion, beforeManualVersion + 1);
      assert.ok(manualResume.aircraft.every(target => !target.stopped && target.extrapolatedSeconds < 1));
      hostLike90Seconds = { durationMs: simulationNow - hostT0, timeline, frozenAtSelection: selected30, resumedBy: 'manual-refresh', resumed: manualResume,
        authoritativeVersions: [100, 101], meaningfulDeadlineUnchangedBySelections: true,
        maxPendingRaf: 1, maxPendingPollTimers: manualResume.pollTimers.maxPending, maxPendingAgeTimers: manualResume.ageTimers.maxPending };
    } else {
      assert.ok(selected30.nextPollAt <= hostT0 + 31_000, 'area reprojection preserves the earlier watchdog deadline');
      await advanceHostTo(30_900);
      currentResult = synthetic(await rpc('airport:KMDW'), null, 101, hostT0 + 31_000, hostT0 + 31_000);
      await queue(currentResult);
      await advanceHostTo(31_100);
      await waitFor(page, version => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === version, 101);
      const automaticResume = await hostCapture('T+31 bounded watchdog accepts a newer trajectory without manual Refresh');
      assert.ok(automaticResume.aircraft.every(target => !target.stopped && target.extrapolatedSeconds < 1));
      assert.equal(automaticResume.selectedRadarId, selected30.selectedRadarId);

      await advanceHostTo(35_000); await select(movingIds[2]);
      const selectedC = await hostCapture('T+35 select aircraft C'); assert.equal(selectedC.nextPollAt, automaticResume.nextPollAt);
      await advanceHostTo(40_000); await hostFrame.locator('#view-flights').click();
      const flights40 = await hostCapture('T+40 Radar to Flights'); assert.equal(flights40.animationScheduled, true);
      await advanceHostTo(42_000); await hostFrame.locator('#view-radar').click();
      const radar42 = await hostCapture('T+42 Flights to Radar'); assert.equal(radar42.animationScheduled, true);

      await advanceHostTo(50_900);
      currentResult = synthetic(await rpc('airport:KMDW'), null, 102, hostT0 + 51_000, hostT0 + 51_000);
      await queue(currentResult); await advanceHostTo(51_100);
      await waitFor(page, version => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === version, 102);
      const fresh51 = await hostCapture('T+51 normal cadence accepts fresh trajectory');
      assert.ok(Math.abs(fresh51.nextPollAt - (hostT0 + 71_000)) <= 100);

      await advanceHostTo(56_000); await select(movingIds[3]);
      const selectedD = await hostCapture('T+56 select aircraft D'); assert.equal(selectedD.nextPollAt, fresh51.nextPollAt);
      await advanceHostTo(70_000);
      currentResult = synthetic(await rpc('airport:KMDW'), null, 103, simulationNow, simulationNow);
      await queue(currentResult); await hostFrame.locator('#refresh').click();
      await waitFor(page, version => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === version, 103);
      const manualControl = await hostCapture('T+70 manual Refresh control accepts fresh trajectory');
      assert.ok(manualControl.aircraft.every(target => !target.stopped));

      await advanceHostTo(75_000); await select(movingIds[0]);
      const selectedE = await hostCapture('T+75 select aircraft A again'); assert.equal(selectedE.nextPollAt, manualControl.nextPollAt);
      await advanceHostTo(89_900);
      currentResult = synthetic(await rpc('airport:KMDW'), null, 104, hostT0 + 90_000, hostT0 + 90_000);
      await queue(currentResult); await advanceHostTo(90_100);
      await waitFor(page, version => document.getElementById('radar').contentWindow.inboundRadarProof.read().collectionVersion === version, 104);
      const final90 = await hostCapture('T+90 normal cadence remains healthy');
      assert.ok(simulationNow - hostT0 >= 90_000);
      assert.ok(timeline.every(sample => sample.animationScheduled));
      assert.ok(timeline.filter(sample => sample.at >= automaticResume.at).every(sample => !sample.aircraft.length || sample.aircraft.some(target => !target.stopped)));
      assert.equal(final90.pollTimers.maxPending, 1); assert.equal(final90.ageTimers.maxPending, 1);
      hostLike90Seconds = { durationMs: simulationNow - hostT0, timeline, safetyCap: cap25, resumedBy: 'automatic-watchdog', resumed: automaticResume,
        manualRefreshControl: manualControl, authoritativeVersions: [100, 101, 102, 103, 104], meaningfulDeadlineUnchangedBySelections: true,
        maxPendingRaf: 1, maxPendingPollTimers: final90.pollTimers.maxPending, maxPendingAgeTimers: final90.ageTimers.maxPending };
    }
  }

  const diagnostics = service.diagnostics();
  assert.equal(diagnostics.providerApiCalls, 0); assert.equal(diagnostics.productionApiCalls, 0); assert.equal(diagnostics.productionDbAccess, 0);
  const result = { ok: true, expected: expectGap ? 'baseline-gap' : expectWatchdogFreeze ? 'motion-watchdog-before-fix' : 'motion-watchdog-fix', policyTimeline: {
    clientDeadlineArmedAt: new Date(clientT0).toISOString(), publicationAt: new Date(clientT0 + 800).toISOString(),
    scheduledRequestAt: new Date(clientT0 + 20_000).toISOString(), retryOpportunityAt: new Date(clientT0 + 23_000).toISOString(),
    originalMotionCapAt: new Date(clientT0 + 25_000).toISOString(),
  }, captures: [armed, published, selectionAt19, sameAtTwenty, beforeRetry, afterRetry, selectionAt24, afterBound], remainingScriptedResults,
    boundedSameRetry, hostLike90Seconds, isolation: { aviationProviderCalls: stats.aviationProviderCalls, productionApiCalls: stats.productionApiCalls,
      productionDbAccess: stats.productionDbAccess, serviceProviderApiCalls: diagnostics.providerApiCalls,
      serviceProductionApiCalls: diagnostics.productionApiCalls, serviceProductionDbAccess: diagnostics.productionDbAccess } };
  const output = resolve(evidenceDirectory, expectGap ? 'transient-gap-before-fix.json' : expectWatchdogFreeze ? 'motion-watchdog-before-fix.json' : 'motion-watchdog-after-fix.json');
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, expected: result.expected, output, finalVersion: afterBound.collectionVersion,
    rafAdvancedAtCap: afterBound.frameCount > framesBeforeBound, allStoppedAtCap: afterBound.aircraft.every(target => target.stopped) }));
} finally {
  await browser?.close();
  for (const handle of [harness, server]) if (handle) { handle.closeAllConnections(); await new Promise(resolveClose => handle.close(resolveClose)); }
  await dispose?.(); restoreClock();
}
