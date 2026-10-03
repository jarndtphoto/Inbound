import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createFixtureProofServer } from '../src/lib/plugin-v1/proof-server.ts';

// Component/lifecycle tests only. This is NOT a ChatGPT host verification.
const output = '/workspace/screenshots/inbound-plugin-interactions.json';
const assertions = [];
const {server, stats} = createFixtureProofServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
const root = `http://127.0.0.1:${server.address().port}`;
const harnessHtml = `<!doctype html><html><head><meta charset="utf-8"><title>SIMULATED HOST — not ChatGPT</title></head><body>
<h1>SIMULATED HOST — not ChatGPT</h1><p>Tests message handling only. No real PiP or conversation persistence is claimed.</p>
<label>Simulated conversation <input id="conversation"></label><button id="remount">Remount fixture</button><button id="teardown">Send simulated teardown</button>
<iframe id="fixture" title="Static fixture component" src="/widget" style="width:680px;height:790px;border:1px solid #ddd"></iframe>
<script>
window.fixtureSavedState={};window.fixtureMessages=[];window.fixtureTeardownAcknowledged=false;
const frame=()=>document.getElementById('fixture');
document.getElementById('remount').onclick=()=>{frame().src='/widget';};
document.getElementById('teardown').onclick=()=>{frame().contentWindow.postMessage({jsonrpc:'2.0',id:777,method:'ui/resource-teardown',params:{reason:'simulated session ended'}},location.origin);};
window.addEventListener('message',async event=>{
 if(event.source!==frame().contentWindow || event.data?.jsonrpc!=='2.0')return;
 const m=event.data;if(m.id===777&&m.result){window.fixtureTeardownAcknowledged=true;return;}
 if(!m.method)return;window.fixtureMessages.push(m.method);let result;
 if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'SIMULATED HOST',version:'0'},hostCapabilities:{},hostContext:{displayMode:'inline',availableDisplayModes:['inline','pip','fullscreen']}};
 else if(m.method==='tools/call'){const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:m.id,method:'tools/call',params:m.params})});result=(await response.json()).result;}
 else if(m.method==='ui/request-display-mode')result={mode:'inline'}; // deliberately decline all modes
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
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(url.hostname)){externalRequests++;return route.abort();}return route.continue();});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.clock.install({time:new Date('2030-01-15T18:00:06Z')});
  await page.goto(root+'/widget');
  assert.equal(await page.locator('.card').count(),4);assert.equal(await page.locator('#pip').isEnabled(),false);assert.equal(await page.locator('#fullscreen').isEnabled(),false);
  assertions.push('Standalone inline four-card rendering and honest disabled host controls');
  await page.locator('.card').first().click();
  const selected=await page.evaluate(()=>window.inboundFixtureProof.read().selectedCardId);
  const firstCard=await page.locator('.card').first().getAttribute('data-card-id');assert.equal(selected,firstCard);
  await page.clock.fastForward(21000);await page.waitForFunction(()=>window.inboundFixtureProof.read().refreshCalls>=1);
  assert.equal(await page.locator('.card').first().getAttribute('aria-pressed'),'true');assert.ok((await page.locator('.card').first().innerText()).includes('Updated 27 sec ago'));
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.cardId),selected);
  assertions.push('Visible periodic fixture HTTP refresh; advancing age, selected ID and keyboard focus retained');
  await page.locator('#refresh').click();assert.ok((await page.locator('.card').first().innerText()).includes('Updated 27 sec ago'));
  assertions.push('Static fixture reread does not reset position age');
  await page.locator('#pause').click();const pausedCalls=await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls);
  await page.clock.fastForward(21000);assert.equal(await page.evaluate(()=>window.inboundFixtureProof.read().refreshCalls),pausedCalls);
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
  await page.locator('#area').selectOption('airport:KMDW');await page.waitForFunction(()=>document.getElementById('area-title').textContent==='Near MDW');
  assertions.push('Area control uses Inbound fixture resolver and named ORD/MDW references');
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
  await page.locator('#teardown').click();await page.waitForFunction(()=>window.fixtureTeardownAcknowledged);
  const teardownCalls=stats.toolCalls;await page.clock.fastForward(21000);assert.equal(stats.toolCalls,teardownCalls);
  assertions.push('MOCK ONLY: Standard teardown acknowledgment and polling shutdown');
  assert.equal(externalRequests,0);assert.deepEqual(errors,[]);
  mkdirSync('/workspace/screenshots',{recursive:true});
  writeFileSync(output,JSON.stringify({ok:true,scope:'Local component and explicitly SIMULATED host only; actual ChatGPT not confirmed',assertions,externalRequests,errors,fixtureToolCalls:stats.toolCalls,actualChatGptVerified:false},null,2));
  console.log(JSON.stringify({ok:true,assertions:assertions.length,scope:'Local component; MOCK host; not actual ChatGPT',output}));
}finally{
  await browser?.close();for(const s of [harness,server]){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
}
