import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createFixtureProofServer } from '../src/lib/plugin-v1/proof-server.ts';

// Component/lifecycle tests only. This is NOT a ChatGPT host verification.
const compiled = process.argv.includes('--compiled');
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
const output = `/workspace/screenshots/inbound-plugin-interactions${compiled ? '-compiled' : ''}.json`;
const assertions = [];
const previousEnvironment = process.env;
let server, stats;
if (compiled) {
  const { default: handler } = await import(pathToFileURL(resolve('deploy/plugin-v1-fixture-preview/api/mcp.js')).href);
  const host = 'inbound-live-fixture-local-test.vercel.app';
  process.env = { NO_PROXY: previousEnvironment.NO_PROXY, no_proxy: previousEnvironment.no_proxy, VERCEL_ENV: 'preview', VERCEL_URL: host };
  stats = { toolCalls: 0 };
  server = createServer((req,res)=>{
    // Local test transport simulates the Vercel authority, including Origin.
    // The compiled application's authority/origin guard remains unchanged.
    req.headers.host=host;if(req.headers.origin===root)req.headers.origin=`https://${host}`;
    if(req.method==='POST' && req.url==='/mcp')stats.toolCalls++;void handler(req,res);
  });
} else ({server, stats} = createFixtureProofServer());
server.listen(0,'127.0.0.1'); await once(server,'listening');
const root = `http://127.0.0.1:${server.address().port}`;
const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>SIMULATED HOST — not ChatGPT</title></head><body>
<h1>SIMULATED HOST — not ChatGPT</h1><p>Tests message handling only. No real PiP or conversation persistence is claimed.</p>
<label>Simulated conversation <input id="conversation"></label><button id="remount">Remount fixture</button><button id="teardown">Send simulated teardown</button>
<iframe id="fixture" title="Static fixture component" src="/widget" style="width:680px;height:790px;border:1px solid #ddd"></iframe>
<script>
window.fixtureSavedState={};window.fixtureMessages=[];window.fixtureTeardownAcknowledged=false;window.fixtureModes=['inline','pip','fullscreen'];window.fixtureDisplayMode='inline';window.fixtureAcceptDisplay=false;
const frame=()=>document.getElementById('fixture');
document.getElementById('remount').onclick=()=>{frame().src='/widget';};
document.getElementById('teardown').onclick=()=>{frame().contentWindow.postMessage({jsonrpc:'2.0',id:777,method:'ui/resource-teardown',params:{reason:'simulated session ended'}},location.origin);};
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow || event.data?.jsonrpc!=='2.0')return;
 const m=event.data;if(m.id===777&&m.result){window.fixtureTeardownAcknowledged=true;return;}
 if(!m.method)return;window.fixtureMessages.push(m.method);let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'SIMULATED HOST',version:'0'},hostCapabilities:{},hostContext:{displayMode:window.fixtureDisplayMode,availableDisplayModes:window.fixtureModes}};
 else if(m.method==='tools/call'){const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:m.id,method:'tools/call',params:m.params})});result=(await response.json()).result;}
 else if(m.method==='ui/request-display-mode')result={mode:window.fixtureAcceptDisplay ? m.params.mode : 'inline'};
 else return;
 event.source.postMessage({jsonrpc:'2.0',id:m.id,result},event.origin);
});
</script></body></html>`;
const harness = createServer(async (req,res)=>{
  if(req.url==='/harness'){res.writeHead(200,{'Content-Type':'text/html'});res.end(harnessHtml);return;}
  try {
    const buffers=[];for await(const b of req)buffers.push(b);
    const response=await fetch(root+(req.url || '/'),{method:req.method,headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},...(req.method==='POST'?{body:Buffer.concat(buffers)}:{})});
    res.writeHead(response.status,{'Content-Type':response.headers.get('Content-Type') || 'text/plain'});res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Fixture test proxy failed');}
});harness.listen(0,'127.0.0.1');await once(harness,'listening');
const harnessRoot=`http://127.0.0.1:${harness.address().port}`;
let browser;
const errors=[];let externalRequests=0;
try {
  browser=await chromium.launch({...(chromiumExecutable ? {executablePath:chromiumExecutable} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--single-process','--no-zygote','--in-process-gpu','--use-gl=angle','--use-angle=swiftshader']});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(url.hostname)){externalRequests++;return route.abort();}return route.continue();});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.clock.install({time:new Date('2030-01-15T18:00:06Z')});
  await page.goto(root+'/widget');
  assert.equal(await page.locator('.card').count(),4);assert.equal(await page.locator('#pip').isEnabled(),false);assert.equal(await page.locator('#fullscreen').isEnabled(),false);
  assert.equal(await page.locator('#view-flights').getAttribute('aria-selected'),'true');
  assertions.push('Standalone inline four-card rendering and honest disabled host controls');
  await page.locator('.card').first().click();
  const selected=await page.evaluate(()=>window.inboundFixtureProof.read().selectedCardId);
  const firstCard=await page.locator('.card').first().getAttribute('data-card-id');assert.equal(selected,firstCard);
  await page.locator('#view-radar').click();
  assert.equal(await page.locator('.aircraft-marker').count(),4);
  assert.equal(await page.locator('[data-airport="ORD"]').count(),1);assert.equal(await page.locator('[data-airport="MDW"]').count(),1);
  assert.equal(await page.locator('.aircraft-marker[aria-pressed="true"]').getAttribute('data-card-id'),selected);
  const originalPositions=await page.evaluate(()=>window.inboundFixtureProof.read().positions);
  const originalMarkers=await page.locator('.aircraft-marker').evaluateAll(nodes=>nodes.map(n=>[n.dataset.cardId,n.style.left,n.style.top]));
  assertions.push('Chicago Radar renders the same four observed fixture coordinates and both airport markers');
  await page.locator('.aircraft-marker').nth(2).click();
  const radarSelected=await page.locator('.aircraft-marker').nth(2).getAttribute('data-card-id');
  assert.equal(await page.locator('#selected-ident').innerText(),'AAL1070');
  assert.match(await page.locator('#selected-motion').innerText(),/Descending.*falling/);
  assert.match(await page.locator('#selected-altitude').getAttribute('aria-label'),/7400 feet, falling/);
  assert.equal(await page.locator('#selected-route').innerText(),'Route unavailable');
  assert.match(await page.locator('.aircraft-marker').nth(2).getAttribute('aria-label'),/falling.*heading unavailable/);
  assertions.push('Radar selection exposes heading availability, text altitude direction and truthful selected summary');
  const beforeTrack=stats.toolCalls;
  assert.equal(await page.locator('#track-flight').isEnabled(),false);
  await page.locator('#track-flight').evaluate(node=>node.click());
  assert.equal(stats.toolCalls,beforeTrack);
  assertions.push('Disabled Track flight cannot create a fixture or provider request');
  await page.locator('#view-flights').click();
  assert.equal(await page.locator('.card[aria-pressed="true"]').getAttribute('data-card-id'),radarSelected);
  await page.locator('.card').first().click();
  await page.locator('#view-radar').click();
  assert.equal(await page.locator('.aircraft-marker[aria-pressed="true"]').getAttribute('data-card-id'),selected);
  assertions.push('Card and Radar selection are synchronized across both view switches');
  await page.locator('#view-radar').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#view-flights').getAttribute('aria-selected'),'true');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#view-radar').getAttribute('aria-selected'),'true');
  await page.locator('.aircraft-marker').nth(1).focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('.aircraft-marker').nth(1).getAttribute('aria-pressed'),'true');
  await page.locator('#view-flights').click();await page.locator('.card').first().click();
  assertions.push('Tabs and aircraft markers are keyboard selectable with exposed selected state');
  const age = async()=>Number((await page.locator('.card').first().innerText()).match(/Updated (\d+) sec ago/)[1]);
  const initialAge=await age();
  await page.clock.fastForward(21000);await page.waitForFunction(()=>window.inboundFixtureProof.read().refreshCalls>=1);
  assert.equal(await page.locator('.card').first().getAttribute('aria-pressed'),'true');assert.ok(await age()>=initialAge+21);
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.cardId),selected);
  assertions.push('Visible periodic fixture HTTP refresh; advancing age, selected ID and keyboard focus retained');
  assert.deepEqual(await page.evaluate(()=>window.inboundFixtureProof.read().positions),originalPositions);
  await page.locator('#view-radar').click();
  assert.deepEqual(await page.locator('.aircraft-marker').evaluateAll(nodes=>nodes.map(n=>[n.dataset.cardId,n.style.left,n.style.top])),originalMarkers);
  await page.locator('#view-flights').click();
  assertions.push('Local age ticks and fixture rereads never move Radar positions or change observation timestamps');
  const beforeReread=await age();await page.locator('#refresh').click();assert.ok(await age()>=beforeReread);
  assertions.push('Static fixture reread does not reset position age');
  await page.locator('#pause').click();const pausedCalls=await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls), pausedAge=await age();
  await page.clock.fastForward(21000);assert.equal(await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls),pausedCalls);
  assert.ok(await age()>=pausedAge+21);
  assertions.push('Pause stops fixture requests while local observation ages continue advancing');
  await page.locator('#pause').click();await page.waitForFunction(before=>window.inboundFixtureProof.read().refreshCalls>before,pausedCalls);
  assertions.push('Pause stops polling; resume refreshes immediately');
  await page.reload();assert.equal(await page.locator('.card').first().getAttribute('aria-pressed'),'true');
  assertions.push('Standalone browser session storage restores selected fixture on reload');
  await page.evaluate(()=>{window.fixtureHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.fixtureHidden});document.dispatchEvent(new Event('visibilitychange'));});
  const hiddenCalls=await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls);
  await page.clock.fastForward(21000);assert.equal(await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls),hiddenCalls);assert.equal(await page.evaluate(()=>window.inboundFixtureProof.read().pollScheduled),false);
  await page.evaluate(()=>{window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(before=>window.inboundFixtureProof.read().refreshCalls>before,hiddenCalls);
  assertions.push('Simulated browser visibility event stops polling; visible event refreshes');
  await page.locator('#area').selectOption('airport:KORD');await page.waitForFunction(()=>document.getElementById('area-title').textContent==='Near ORD');
  assert.ok((await page.locator('#reference').innerText()).includes('ORD reference'));
  await page.locator('#view-radar').click();assert.equal(await page.locator('[data-airport="ORD"]').getAttribute('data-primary'),'true');
  const ordMarkers=await page.locator('.aircraft-marker').evaluateAll(nodes=>nodes.map(n=>[n.style.left,n.style.top]));
  assert.equal(await page.locator('#radar-reference').innerText(),'ORD reference');
  assert.deepEqual(await page.evaluate(()=>window.inboundFixtureProof.read().positions),originalPositions);
  await page.locator('#area').selectOption('airport:KMDW');await page.waitForFunction(()=>document.getElementById('area-title').textContent==='Near MDW');
  assert.equal(await page.locator('[data-airport="MDW"]').getAttribute('data-primary'),'true');
  assert.equal(await page.locator('[data-airport="ORD"]').getAttribute('data-primary'),'false');
  assert.equal(await page.locator('#radar-reference').innerText(),'MDW reference');
  assert.notDeepEqual(await page.locator('.aircraft-marker').evaluateAll(nodes=>nodes.map(n=>[n.style.left,n.style.top])),ordMarkers);
  assert.deepEqual(await page.evaluate(()=>window.inboundFixtureProof.read().positions),originalPositions);
  assertions.push('Area control uses Inbound fixture resolver and named ORD/MDW references');
  assertions.push('ORD/MDW recenter and mark the primary airport without relocating the invented observations');
  await page.locator('#dismiss').click();const dismissedCalls=await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls);
  await page.clock.fastForward(21000);assert.equal(await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls),dismissedCalls);assert.equal(await page.locator('#cards').isVisible(),false);
  assertions.push('Dismiss hides board and stops fixture requests');

  await page.addInitScript(()=>{
    if(window.parent!==window)window.openai={get widgetState(){return window.parent.fixtureSavedState;},setWidgetState:state=>{window.parent.fixtureSavedState=state;}};
  });
  await page.goto(harnessRoot+'/harness');
  const frame=page.frameLocator('#fixture');
  await frame.locator('#pip').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof?.read().hostReady);
  const inlineHeight=await frame.locator('#proof').evaluate(node=>node.getBoundingClientRect().height);
  mkdirSync('/workspace/screenshots',{recursive:true});
  await frame.locator('#proof').screenshot({path:`/workspace/screenshots/inbound-flights-inline${compiled ? '-compiled' : ''}.png`});
  assert.ok(inlineHeight<790,`Desktop inline height: ${inlineHeight}px`);
  assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assertions.push('Desktop inline stays within the compact fixture frame without horizontal overflow');
  await frame.locator('.card').first().click();
  const mockSelected=await page.evaluate(()=>window.fixtureSavedState.selectedCardId);assert.ok(mockSelected);
  await page.locator('#conversation').fill('A simulated conversation interaction, not a ChatGPT conversation.');
  assert.equal(await frame.locator('.card').first().getAttribute('aria-pressed'),'true');
  await frame.locator('#pip').click();assert.equal(await page.evaluate(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof.read().displayMode),'inline');
  await frame.locator('#fullscreen').click();assert.equal(await page.evaluate(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof.read().displayMode),'inline');
  assertions.push('MOCK ONLY: Apps initialization and declined PiP/fullscreen requests preserve inline fallback');
  await page.clock.fastForward(21000);await page.waitForFunction(()=>window.fixtureMessages.includes('tools/call'));
  assert.ok(!(await page.evaluate(()=>window.fixtureMessages)).some(m=>m==='ui/message'||m.startsWith('sampling/')));
  assertions.push('MOCK ONLY: UI tools/call refresh without any component model/message request');
  await Promise.all([page.waitForEvent('framenavigated',{predicate:f=>f.parentFrame()!==null}),page.locator('#remount').click()]);
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof?.read().hostReady);
  assert.equal(await page.evaluate(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof.read().selectedCardId),mockSelected);
  assertions.push('MOCK ONLY: OpenAI widget-state adapter restores selection across a simulated remount');
  await frame.locator('#view-radar').click();
  assert.equal(await page.evaluate(()=>window.fixtureSavedState.views.inline),'radar');
  await Promise.all([page.waitForEvent('framenavigated',{predicate:f=>f.parentFrame()!==null}),page.locator('#remount').click()]);
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof?.read().hostReady);
  assert.equal(await frame.locator('#view-radar').getAttribute('aria-selected'),'true');
  assert.equal(await frame.locator('.aircraft-marker[aria-pressed="true"]').getAttribute('data-card-id'),mockSelected);
  assertions.push('MOCK ONLY: Widget state restores selected view and aircraft across remount');
  await page.evaluate(()=>{
    window.fixtureAcceptDisplay=true;window.fixtureModes=['inline','fullscreen'];
    document.getElementById('fixture').style.border='0';document.getElementById('fixture').style.width='1120px';document.getElementById('fixture').style.height='1120px';
    document.getElementById('fixture').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{availableDisplayModes:window.fixtureModes}},location.origin);
  });
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.document.getElementById('pip').disabled);
  const beforePip=await page.evaluate(()=>window.fixtureMessages.filter(m=>m==='ui/request-display-mode').length);
  await frame.locator('#pip').evaluate(node=>node.click());
  assert.equal(await page.evaluate(()=>window.fixtureMessages.filter(m=>m==='ui/request-display-mode').length),beforePip);
  assertions.push('MOCK ONLY: Host without PiP keeps Request PiP disabled without a request or error');
  await frame.locator('#view-flights').click();await frame.locator('#fullscreen').click();
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof.read().displayMode==='fullscreen');
  assert.equal(await frame.locator('#proof').getAttribute('data-display-mode'),'fullscreen');
  assert.equal(await frame.locator('#view-radar').getAttribute('aria-selected'),'true');
  assert.equal(await frame.locator('.aircraft-marker[aria-pressed="true"]').getAttribute('data-card-id'),mockSelected);
  assert.equal(await frame.locator('#track-flight').isEnabled(),false);
  const desktop=await frame.locator('body').evaluate(body=>({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,radar:document.getElementById('radar-surface').getBoundingClientRect().toJSON(),summary:document.getElementById('selected').getBoundingClientRect().toJSON(),text:body.innerText}));
  assert.equal(desktop.overflow,false);assert.ok(desktop.radar.width>desktop.summary.width*2);assert.ok(desktop.radar.height>=420);
  assert.ok(desktop.summary.y<=desktop.radar.y && desktop.summary.x>=desktop.radar.x+desktop.radar.width, 'summary is beside the radar panel');
  assert.match(desktop.text,/Static fixture/);
  mkdirSync('/workspace/screenshots',{recursive:true});
  await frame.locator('#proof').screenshot({path:`/workspace/screenshots/inbound-radar-expanded${compiled ? '-compiled' : ''}.png`});
  assertions.push('MOCK ONLY: Accepted fullscreen defaults to Radar with a dominant desktop surface and readable side summary');
  await frame.locator('#view-flights').click();await frame.locator('#view-radar').click();
  assert.equal(await frame.locator('.aircraft-marker[aria-pressed="true"]').getAttribute('data-card-id'),mockSelected);
  await page.evaluate(()=>{document.getElementById('fixture').style.width='375px';document.getElementById('fixture').style.height='1400px';});
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.innerWidth===375);
  const mobile=await frame.locator('body').evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,markers:[...document.querySelectorAll('.aircraft-marker')].map(n=>({label:n.getAttribute('aria-label'),pressed:n.getAttribute('aria-pressed'),rect:n.getBoundingClientRect().toJSON()})),radar:document.getElementById('radar-surface').getBoundingClientRect().toJSON()}));
  assert.equal(mobile.overflow,false);assert.equal(mobile.markers.length,4);
  assert.ok(mobile.markers.every(m=>m.rect.width>=44 && m.rect.height>=44 && m.label.includes('feet') && m.label.includes('heading unavailable')));
  assert.ok(mobile.radar.width<=375);assert.ok(mobile.radar.height>=300);
  for(let index=0;index<4;index++){const marker=frame.locator('.aircraft-marker').nth(index);await marker.click();assert.equal(await marker.getAttribute('aria-pressed'),'true');}
  await frame.locator('.aircraft-marker').first().click();
  await frame.locator('#proof').screenshot({path:`/workspace/screenshots/inbound-radar-mobile${compiled ? '-compiled' : ''}.png`});
  assertions.push('375px simulation: Radar has four accessible 44px targets and no sideways overflow');
  await frame.locator('#view-flights').click();assert.equal(await frame.locator('.card').count(),4);
  assert.equal(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await frame.locator('#proof').screenshot({path:`/workspace/screenshots/inbound-flights-mobile${compiled ? '-compiled' : ''}.png`});
  await frame.locator('#fullscreen').click();
  await page.waitForFunction(()=>document.getElementById('fixture').contentWindow.inboundFixtureProof.read().displayMode==='inline');
  assert.equal(await frame.locator('#view-flights').getAttribute('aria-selected'),'true');
  assertions.push('375px simulation: readable four-card Flights and independent inline/fullscreen view persistence');
  await frame.locator('#view-radar').click();
  await page.clock.fastForward(125000);
  assert.equal(await frame.locator('.aircraft-marker').count(),0);assert.equal(await frame.locator('.card').count(),0);
  assert.match(await frame.locator('#selected-age').innerText(),/Observation expired/);
  assert.match(await frame.locator('#board-notice').innerText(),/expired/);
  assertions.push('Both views enforce the same 120-second safety window with honest expired summary');
  await page.locator('#teardown').click();await page.waitForFunction(()=>window.fixtureTeardownAcknowledged);
  const teardownCalls=stats.toolCalls;await page.clock.fastForward(21000);assert.equal(stats.toolCalls,teardownCalls);
  assertions.push('MOCK ONLY: Standard teardown acknowledgment and polling shutdown');
  assert.equal(externalRequests,0);assert.deepEqual(errors,[]);
  mkdirSync('/workspace/screenshots',{recursive:true});
  writeFileSync(output,JSON.stringify({ok:true,compiled,scope:'Local component and explicitly SIMULATED host only; actual ChatGPT not confirmed',assertions,externalRequests,errors,fixtureToolCalls:stats.toolCalls,desktop,mobile,actualChatGptVerified:false},null,2));
  console.log(JSON.stringify({ok:true,compiled,assertions:assertions.length,externalRequests,errors,scope:'Local component; MOCK host; not actual ChatGPT',output}));
}finally{
  await browser?.close();for(const s of [harness,server]){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
  process.env=previousEnvironment;
}
