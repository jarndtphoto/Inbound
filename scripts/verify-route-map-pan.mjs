// Actual RouteMap interactions, using local fixtures and trusted browser input.
// Compare phone touch gestures with the approved main route-map, without providers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright';
const dir = await mkdtemp(resolve('node_modules/.map-pan-ui-')), output = join(dir, 'out');
const screenshots = process.env.MAP_SCREENSHOT_DIR || '/workspace/screenshots/map-pan';
let browser, server;
try {
  const baseline = execFileSync('git', ['show', '77f6aa2:src/components/route-map.tsx'], {encoding:'utf8'})
    .replace(/from "(\.\/[^\"]+)"/g, (_, path) => 'from ' + JSON.stringify(resolve('src/components', path)));
  await writeFile(join(dir, 'main-map.tsx'), baseline);
  await writeFile(join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(dir, 'entry.tsx'), `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {RouteMap} from ${JSON.stringify(resolve('src/components/route-map.tsx'))};
    import {RouteMap as MainMap} from './main-map';
    import {useFiled} from ${JSON.stringify(resolve('src/lib/store.ts'))};
    import {polishStory} from ${JSON.stringify(resolve('scripts/fixtures/presentation-polish.mjs'))};
    import {arrivalPattern} from ${JSON.stringify(resolve('src/lib/arrival-pattern.ts'))};
    import ${JSON.stringify(resolve('src/styles.css'))};
    useFiled.setState({weatherOn:false});
    const story=polishStory(), runway={runway:'10R',source:'provider',estimated:false,threshold:{lat:41.9678,lon:-87.9411},heading:90};
    story.dest={...story.origin}; story.origin={...story.origin,iata:'TEST',lat:41.7,lon:-88.7};
    story.aircraft={...story.aircraft,lat:41.99,lon:-88.35,track:270,altFt:5000};
    const pattern=arrivalPattern(story.aircraft,runway);
    story.route={...story.route,progress:0,totalNm:50,remainingNm:pattern.lengthNm,etaMin:12,source:'track',expectedArrival:runway,arrivalPatternKind:pattern.kind,
      samples:pattern.points.map((p,i)=>({...p,frac:i/(pattern.points.length-1),etaMin:12*i/(pattern.points.length-1),chop:i<6?'light':i>12&&i<18?'moderate':'smooth',cloud:false,convective:false,note:null}))};
    const Map=location.search.includes('baseline')?MainMap:RouteMap;
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><main style={{height:'100dvh',maxWidth:800,margin:'auto',display:'flex',flexDirection:'column'}}><h1 style={{fontSize:14,padding:8}}>Local map interaction fixture · ORD 10R</h1><section style={{flex:1,minHeight:0}}><Map story={story} fixedViewport /></section></main></QueryClientProvider>);
  `);
  await build({root:dir,configFile:false,logLevel:'silent',publicDir:false,resolve:{alias:{'@':resolve('src')}},plugins:[{name:'scan-app',enforce:'pre',transform(code,id){if(id===resolve('src/styles.css'))return code+'\n@source '+JSON.stringify(resolve('src'))+';';}},react(),tailwind()],build:{outDir:output}});
  server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=join(output,path==='/'?'index.html':path);res.setHeader('content-type',{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
  await mkdir(screenshots,{recursive:true});
  const url=`http://127.0.0.1:${server.address().port}/`, errors=[], blocked=[];
  async function open(phone=false, baseline=false) {
    const page=await browser.newPage({viewport:phone?{width:390,height:844}:{width:1280,height:800},isMobile:phone,hasTouch:phone});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();blocked.push(r.request().url());return r.abort();});
    await page.goto(url+(baseline?'?baseline':''));await page.locator('[data-route-map]').waitFor();
    await settle(page);return page;
  }
  async function settle(page) {await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
  async function view(page) {return page.locator('[data-route-map] > g').first().evaluate(e=>{
    const m=e.transform.baseVal.consolidate().matrix; return {s:m.a,x:m.e,y:m.f};
  });}
  function near(a,b) {for(const k of ['s','x','y'])assert.ok(Math.abs(a[k]-b[k])<0.05,`${k}: ${a[k]} vs ${b[k]}`);}
  const touchSessions=new WeakMap();
  async function touch(page, points, type) {let cdp=touchSessions.get(page);if(!cdp){cdp=await page.context().newCDPSession(page);touchSessions.set(page,cdp);}await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y,id])=>({x,y,id:id??1}))});await settle(page);}
  const desktop=await open(), box=await desktop.locator('[data-map-box]').boundingBox();
  const start={x:box.x+box.width*.45,y:box.y+box.height*.4};
  await desktop.mouse.move(start.x,start.y);await desktop.mouse.down();await desktop.mouse.move(start.x+70,start.y+40);await settle(desktop);
  let v=await view(desktop);assert.ok(v.x>30&&v.y>20,'mouse pans');
  assert.equal(await desktop.locator('[data-map-box]').evaluate(e=>e.hasPointerCapture(1)),true,'mouse pointer captured');
  await desktop.mouse.move(-100,-100);await settle(desktop);assert.ok((await view(desktop)).x<0,'capture continues outside map');
  await desktop.mouse.up();const stopped=await view(desktop);await desktop.mouse.move(start.x,start.y);await settle(desktop);near(await view(desktop),stopped);
  await desktop.getByRole('button',{name:'Reset map',exact:true}).click();near(await view(desktop),{s:1,x:0,y:0});
  // Pen uses real CDP input so pointer capture is exercised, not a mocked API.
  const pen=await desktop.context().newCDPSession(desktop);
  await pen.send('Input.dispatchMouseEvent',{type:'mousePressed',x:start.x,y:start.y,button:'left',buttons:1,pointerType:'pen'});
  await pen.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+65,y:start.y+35,buttons:1,pointerType:'pen'});await settle(desktop);assert.ok((await view(desktop)).x>30,'pen pans');
  await pen.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:start.x+65,y:start.y+35,button:'left',buttons:0,pointerType:'pen'});await pen.detach();
  await desktop.getByRole('button',{name:'Reset map',exact:true}).click();
  // Descendant targets inside all excluded control types, including an SVG.
  async function injectControls(page){await page.locator('[data-map-box]').evaluate(el=>{
    const controls=document.createElement('div');controls.id='fixture-controls';controls.style.cssText='position:absolute;top:70px;left:15px;z-index:30;display:flex;gap:20px;background:white;color:black;padding:8px';
    controls.innerHTML='<button><svg width="20" height="20"><path d="M1 1L19 19" stroke="black"/></svg><span>Test button</span></button><details><summary><span>Test summary</span></summary>Details</details><a href="#fixture"><span>Test link</span></a>';el.append(controls);
  });}
  await injectControls(desktop);
  for(const selector of ['#fixture-controls button svg','#fixture-controls summary span','#fixture-controls a span','button[aria-label="Zoom in"]']){
    const bounds=await desktop.locator(selector).boundingBox(),before=await view(desktop);
    await desktop.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await desktop.mouse.down();await desktop.mouse.move(start.x,start.y);await settle(desktop);near(await view(desktop),before);await desktop.mouse.up();
  }
  await desktop.locator('#fixture-controls').evaluate(e=>e.remove());
  for(const label of ['Weather alerts','Map details']){const before=await view(desktop);await desktop.getByText(label,{exact:true}).click();near(await view(desktop),before);await desktop.getByText(label,{exact:true}).click();}
  const paths=await desktop.locator('[data-route-stroke="projected"]').evaluateAll(es=>es.map(e=>[e.getAttribute('d'),e.getAttribute('stroke-dasharray')]));assert.ok(paths.length&&paths.every(p=>p[1]==='8 5'));
  const markers=await desktop.locator('[data-entry-lat]').count();assert.ok(markers>0,'weather fixture contains markers');
  const markerWidth=await desktop.locator('[data-entry-lat] circle').first().evaluate(e=>e.getBoundingClientRect().width);
  for(let i=0;i<5;i++)await desktop.getByRole('button',{name:'Zoom in',exact:true}).click();await settle(desktop);
  const chip=desktop.locator('[data-expected-runway-label]');
  assert.equal(await chip.isVisible(),true,'runway chip visible at runway zoom');
  assert.match(await chip.innerText(),/10R/);
  const chipBefore=await chip.boundingBox();await desktop.mouse.move(start.x,start.y);await desktop.mouse.down();await desktop.mouse.move(start.x+20,start.y+15);await desktop.mouse.up();await settle(desktop);
  assert.equal(await chip.isVisible(),true);const chipAfter=await chip.boundingBox();assert.ok(Math.abs(chipAfter.x-chipBefore.x)>5,'runway chip follows drag');
  assert.deepEqual(await desktop.locator('[data-route-stroke="projected"]').evaluateAll(es=>es.map(e=>[e.getAttribute('d'),e.getAttribute('stroke-dasharray')])),paths,'projection unchanged');
  assert.equal(await desktop.locator('[data-entry-lat]').count(),markers,'markers retained');
  assert.ok(Math.abs(await desktop.locator('[data-entry-lat] circle').first().evaluate(e=>e.getBoundingClientRect().width)-markerWidth)<.1,'weather marker screen size unchanged');
  const threshold=()=>desktop.locator('[data-arrival-threshold]').evaluate(e=>{const p=new DOMPoint(0,0).matrixTransform(e.getScreenCTM());return {x:p.x,y:p.y};});
  const anchor=await threshold();await desktop.getByRole('button',{name:'Zoom in',exact:true}).click();await settle(desktop);const after=await threshold();assert.ok(Math.hypot(after.x-anchor.x,after.y-anchor.y)<1,'zoom remains anchored to runway after dragging');
  await desktop.screenshot({path:join(screenshots,'desktop-runway.png')});
  await desktop.getByRole('button',{name:'Reset map',exact:true}).click();for(let i=0;i<5;i++)await desktop.getByRole('button',{name:'Zoom out',exact:true}).click();assert.equal((await view(desktop)).s,.75);
  await desktop.mouse.move(start.x,start.y);await desktop.mouse.down();await desktop.mouse.move(9000,9000);await settle(desktop);v=await view(desktop);assert.equal(v.x,300);await desktop.mouse.move(-9000,-9000);await settle(desktop);assert.equal((await view(desktop)).x,-100);await desktop.mouse.up();
  // The same in-bounds phone inputs must produce identical transforms on main/new.
  const phoneResults=[];
  for(const baseline of [true,false]){
    const page=await open(true,baseline),r=await page.locator('[data-map-box]').boundingBox(),x=r.x+r.width*.5,y=r.y+r.height*.4;
    await touch(page,[[x,y]],'touchStart');await touch(page,[[x+25,y+20]],'touchMove');await touch(page,[],'touchEnd');const drag=await view(page);assert.ok(drag.x>20&&drag.y>20);
    await page.getByRole('button',{name:'Reset map',exact:true}).click();
    await touch(page,[[x-45,y,1],[x+45,y,2]],'touchStart');await touch(page,[[x-63,y+8,1],[x+63,y+8,2]],'touchMove');await touch(page,[],'touchEnd');const pinch=await view(page);assert.ok(pinch.s>1.35&&pinch.s<1.45);
    phoneResults.push({baseline,drag,pinch});
    if(!baseline){
      await injectControls(page);
      for(const selector of ['#fixture-controls button svg','#fixture-controls summary span','#fixture-controls a span']){
        const control=await page.locator(selector).boundingBox(),before=await view(page);
        await touch(page,[[control.x+control.width/2,control.y+control.height/2]],'touchStart');await touch(page,[[x,y]],'touchMove');near(await view(page),before);await touch(page,[],'touchEnd');
      }
      await page.locator('#fixture-controls').evaluate(e=>e.remove());
      for(const label of ['Zoom in','Reset map']){
        const control=await page.getByRole('button',{name:label,exact:true}).boundingBox(),before=await view(page);
        await touch(page,[[control.x+control.width/2,control.y+control.height/2]],'touchStart');await touch(page,[[x,y]],'touchMove');near(await view(page),before);await touch(page,[],'touchEnd');
      }
      // A second finger on the map must not turn an initial control touch into a pinch.
      const control=await page.getByRole('button',{name:'Zoom in',exact:true}).boundingBox(),cx=control.x+control.width/2,cy=control.y+control.height/2,before=await view(page);
      await touch(page,[[cx,cy,1]],'touchStart');await touch(page,[[cx,cy,1],[x,y,2]],'touchStart');await touch(page,[[cx-30,cy-20,1],[x-30,y-20,2]],'touchMove');near(await view(page),before);await touch(page,[],'touchEnd');
      // Ending a blocked gesture must allow the next gesture on the map.
      await touch(page,[[x,y]],'touchStart');await touch(page,[[x+12,y+10]],'touchMove');await touch(page,[],'touchEnd');assert.ok((await view(page)).x>before.x+10);
      const recovered=await view(page);
      for(const label of ['Weather alerts','Map details']){await page.getByText(label,{exact:true}).tap();near(await view(page),recovered);await page.getByText(label,{exact:true}).tap();}
      await page.screenshot({path:join(screenshots,'phone-touch.png')});
    }
    await page.close();
  }
  near(phoneResults[0].drag,phoneResults[1].drag);near(phoneResults[0].pinch,phoneResults[1].pinch);
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  const result={mouseCapture:true,penCapture:true,controlExclusion:true,touchControlExclusion:true,touchControlThenSecondFinger:true,bounds:true,minZoom:.75,runwayChip:true,runwayZoomAnchor:true,weatherMarkers:markers,projectionUnchanged:true,phoneTouchMatchesMain:phoneResults,externalRequests:0,pageErrors:errors};
  await writeFile(join(screenshots,'verdict.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
