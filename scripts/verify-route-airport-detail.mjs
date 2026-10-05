// Actual RouteMap component, captured OSM ground geometry, and trusted phone input.
// The only stub is the cached surface transport, so fetch counts are deterministic.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { gunzipSync } from 'node:zlib';
import { haversineNm } from '../src/lib/geo.ts';
import { runwayThreshold } from '../src/lib/arrival-runway.ts';
import { simplifyRouteAirportSurface } from '../src/lib/route-airport-detail.ts';

const outputDir = process.env.MAP_SCREENSHOT_DIR || '/workspace/screenshots/route-airport-detail';
const temp = await mkdtemp(resolve('node_modules/.route-airport-qa-'));
let browser, server;
try {
  await mkdir(outputDir, { recursive: true });
  const capture = JSON.parse(gunzipSync(await readFile('scripts/fixtures/route-airport-surfaces.json.gz')).toString('utf8'));
  const ends = JSON.parse(await readFile('src/lib/runway-ends.json', 'utf8')).KMCO;
  const runwayEnds = capture.surfaces.KMCO.features.filter(f => f.kind === 'runway').flatMap(f => [f.points[0], f.points.at(-1)]);
  const alignment = ends.map(end => ({ runway: end.ident, offsetMiles: Math.min(...runwayEnds.map(p => haversineNm(runwayThreshold(end), p) * 1.150779)) }));
  const simplification = Object.fromEntries(Object.entries(capture.surfaces).map(([key, value]) => [key, {
    features: value.features.length,
    before: value.features.reduce((sum, f) => sum + f.points.length, 0),
    after: simplifyRouteAirportSurface(value.features).reduce((sum, f) => sum + f.points.length, 0),
  }]));
  await writeFile(join(temp, 'index.html'), '<!doctype html><html data-theme="sunset"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(temp, 'entry.tsx'), `
    import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {RouteMap} from ${JSON.stringify(resolve('src/components/route-map.tsx'))};
    import {useFiled} from ${JSON.stringify(resolve('src/lib/store.ts'))};
    import {polishStory} from ${JSON.stringify(resolve('scripts/fixtures/presentation-polish.mjs'))};
    import {arrivalPattern} from ${JSON.stringify(resolve('src/lib/arrival-pattern.ts'))};
    import {AIRPORTS} from ${JSON.stringify(resolve('src/lib/airports.ts'))};
    import {airportSurfaceQueryOptions} from ${JSON.stringify(resolve('src/lib/airport-surface-query.ts'))};
    import ${JSON.stringify(resolve('src/styles.css'))};
    const surfaces=${JSON.stringify(capture.surfaces)};
    window.surfaceFixtures=surfaces; window.surfaceLoads=[];
    useFiled.setState({weatherOn:false});
    const client=new QueryClient(), base=polishStory();
    base.origin=AIRPORTS.find(a=>a.iata==='PHX'); base.dest=AIRPORTS.find(a=>a.iata==='MCO');
    base.callsign='MAPQA';base.iata='MAPQA';base.currentStage='arrival';
    base.aircraft={...base.aircraft,lat:28.47,lon:-81.8,track:90,altFt:4500,gsKt:180};
    const sample=(p,i,n)=>({...p,frac:i/(n-1),etaMin:i*5,chop:i%4===1?'light':i%4===2?'moderate':'smooth',cloud:false,convective:false,note:null});
    const runway={runway:'18R',source:'wind estimate',estimated:true,threshold:${JSON.stringify(runwayThreshold(ends.find(e=>e.ident==='18R')))},heading:179};
    const line=Array.from({length:20},(_,i)=>({lat:base.origin.lat+(base.dest.lat-base.origin.lat)*i/19,lon:base.origin.lon+(base.dest.lon-base.origin.lon)*i/19}));
    const approach=arrivalPattern(base.aircraft,runway);
    function App(){const[poll,setPoll]=useState(0),[active,setActive]=useState(false),[short,setShort]=useState(false);
      const destination=short?{...base.dest,lat:base.origin.lat,lon:base.origin.lon+.16}:base.dest;
      const points=short?[base.origin,destination]:active?[base.origin,...approach.points]:line;
      const story={...base,dest:destination,aircraft:short?{...base.aircraft,lat:base.origin.lat,lon:base.origin.lon+.08}:base.aircraft,fetchedAt:base.fetchedAt+poll*20000,route:{...base.route,progress:.6,samples:points.map((p,i)=>sample(p,i,points.length)),expectedArrival:active?runway:undefined,arrivalPatternKind:active?approach.kind:undefined}};
      return <QueryClientProvider client={client}><main className="inbound-redesign" style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
        <header style={{padding:12,fontSize:14}}>PHX → MCO · map QA · captured OSM surface</header>
        <nav style={{display:'flex',gap:12,padding:'0 12px 8px'}}><button onClick={()=>setPoll(p=>p+1)}>Poll fixture</button><button onClick={()=>setActive(a=>!a)}>Toggle approach</button><button onClick={()=>client.prefetchQuery(airportSurfaceQueryOptions(base.origin))}>Open ground fixture</button><button onClick={()=>{setActive(false);setShort(true)}}>Both airports stress</button></nav>
        <section className="journey-map journey-map-expanded" style={{flex:1,minHeight:0}}><RouteMap story={story} fixedViewport /></section>
      </main></QueryClientProvider>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  const transport = resolve('src/lib/airport-surface.ts');
  await build({ root: temp, configFile: false, logLevel: 'silent', publicDir: false,
    resolve: { alias: { '@': resolve('src') } },
    plugins: [{ name: 'airport-qa-transport', enforce: 'pre', transform(code, id) {
      if (id === transport) return 'export async function getAirportSurfaceCached(input){window.surfaceLoads.push(input.airport);const value=window.surfaceFixtures[input.airport];if(input.airport==="KMCO"&&Math.abs(input.lat-28.4312)>1){return {...value,features:value.features.map(f=>({...f,points:f.points.map(p=>({lat:p.lat+input.lat-28.4312,lon:p.lon+input.lon+81.3081}))}))};}return value;}';
      if (id === resolve('src/styles.css')) return code + '\n@source ' + JSON.stringify(resolve('src')) + ';';
    } }, react(), tailwind()], build: { outDir: join(temp, 'out') } });
  server = createServer(async (req, res) => {
    try { const pathname = new URL(req.url, 'http://localhost').pathname, file = join(temp, 'out', pathname === '/' ? 'index.html' : pathname);
      res.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream'); res.end(await readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], external = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => { if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue(); external.push(route.request().url()); return route.abort(); });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.locator('[data-route-map]').waitFor();
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const loads = () => page.evaluate(() => window.surfaceLoads);
  const view = () => page.locator('[data-route-map] > g').first().evaluate(el => { const m = el.transform.baseVal.consolidate().matrix; return { s: m.a, x: m.e, y: m.f }; });
  const width = async () => Number(await page.locator('[data-route-map]').getAttribute('data-visible-width-mi'));
  await settle(); assert.deepEqual(await loads(), []);
  for (let i = 0; i < 20; i++) await page.getByRole('button', { name: 'Poll fixture', exact: true }).click();
  assert.deepEqual(await loads(), [], 'routine full-route polls never request surfaces');
  assert.equal(await page.locator('[data-route-airport]').count(), 0);
  await page.screenshot({ path: join(outputDir, 'full-route-phone-dark.png') });
  async function center(selector) {
    const point = await page.locator(selector).evaluate(el => { const p = new DOMPoint(0,0).matrixTransform(el.getScreenCTM()); return {x:p.x,y:p.y}; });
    const box = await page.locator('[data-map-box]').boundingBox(), x=box.x+box.width/2, y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+(x-point.x),y+(y-point.y),{steps:3});await page.mouse.up();await settle();
  }
  async function maxZoom() {
    for(let i=0;i<26;i++){const before=await view();await page.getByRole('button',{name:'Zoom in',exact:true}).click();await settle();if(Math.abs((await view()).s-before.s)<.00001)break;}
    assert.ok((await width())>5.8 && (await width())<6.2, 'maximum width is six miles');
  }
  const marker = '[data-route-map] [data-map-obstacle]:not([data-arrival-threshold]):not([data-map-aircraft])';
  await center(marker); await maxZoom();
  await page.locator('[data-route-airport="KPHX"]').waitFor();assert.deepEqual(await loads(),['KPHX']);
  const fetches=await loads();for(let i=0;i<20;i++)await page.getByRole('button',{name:'Poll fixture',exact:true}).click();assert.deepEqual(await loads(),fetches);
  await page.getByRole('button',{name:'Open ground fixture',exact:true}).click();assert.deepEqual(await loads(),fetches,'ground and flight queries share the same cached result');
  const zoomed=await view();
  const cdp=await page.context().newCDPSession(page);
  async function touch(type,points){await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([x,y,id])=>({x,y,id}))});await settle();}
  const box=await page.locator('[data-map-box]').boundingBox(), x=box.x+box.width/2,y=box.y+box.height*.4;
  await touch('touchStart',[[x,y,1]]);await touch('touchMove',[[x+24,y+16,1]]);await touch('touchEnd',[]);assert.ok((await view()).x>zoomed.x+30);
  await touch('touchStart',[[x-60,y,1],[x+60,y,2]]);await touch('touchMove',[[x-45,y,1],[x+45,y,2]]);await touch('touchEnd',[]);assert.ok((await view()).s<zoomed.s*.8);
  await maxZoom(); await center(marker);
  for(const theme of ['sunset','sunrise']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:join(outputDir,`phx-max-phone-${theme==='sunrise'?'light':'dark'}.png`)});}
  await page.getByRole('button',{name:'Reset map',exact:true}).click();assert.equal((await view()).s,1);assert.equal(await page.locator('[data-route-airport]').count(),0);
  await page.getByRole('button',{name:'Toggle approach',exact:true}).click();await settle();assert.deepEqual(await loads(),['KPHX','KMCO'],'active approach lazily warms only destination');
  await center('[data-arrival-threshold]');await maxZoom();await page.locator('[data-route-airport="KMCO"]').waitFor();
  assert.equal(await page.locator('[data-route-airport] text').count(),0);
  const finalRun = page.locator('[data-route-stroke="projected"]').last();
  const svgAlignment=await page.evaluate(()=>{
    const marker=document.querySelector('[data-arrival-threshold]'), paths=[...document.querySelectorAll('[data-route-stroke="projected"]')], path=paths.at(-1);
    const end=path.getPointAtLength(path.getTotalLength()), a=new DOMPoint(end.x,end.y).matrixTransform(path.getScreenCTM()), b=new DOMPoint(0,0).matrixTransform(marker.getScreenCTM());
    return Math.hypot(a.x-b.x,a.y-b.y);
  });assert.ok(svgAlignment<.05,'dashed path meets threshold exactly at maximum zoom');
  assert.ok(Number(await finalRun.getAttribute('stroke-width'))<1.1);
  for(const theme of ['sunset','sunrise']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:join(outputDir,`mco-max-phone-${theme==='sunrise'?'light':'dark'}.png`)});}
  // Place the two captured airport complexes 9 mi apart for the worst-case simultaneous detail test.
  // This is explicitly a synthetic short-route layout, not PHX/MCO geographic evidence.
  await page.getByRole('button',{name:'Reset map',exact:true}).click();
  await page.getByRole('button',{name:'Both airports stress',exact:true}).click();await settle();
  while(await width()>32){await page.getByRole('button',{name:'Zoom in',exact:true}).click();await settle();}
  await page.locator('[data-route-airport="KPHX"]').waitFor();await page.locator('[data-route-airport="KMCO"]').waitFor();
  const bothAirportShapeCount=await page.locator('[data-route-airport] [data-surface-kind]').count();assert.ok(bothAirportShapeCount>=800);
  const beforeStress=await loads();
  // Both airports now draw while panning; measure render time with a 4x slower CPU.
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
  await page.evaluate(()=>{window.panLongTasks=[];new PerformanceObserver(list=>window.panLongTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});});
  const timings=[];
  for(let i=0;i<20;i++){const start=performance.now();await touch('touchStart',[[x,y,1]]);await touch('touchMove',[[x+8+(i%2)*8,y,1]]);await touch('touchEnd',[]);timings.push(performance.now()-start);}
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  assert.deepEqual(await loads(),beforeStress);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const result={groupsPassed:10,phoneViewport:'390x844',noRoutinePollFetches:true,sharedGroundCache:true,lazyDestinationApproach:true,phoneDrag:true,phonePinch:true,reset:true,maxWidthMiles:6,bothAirportShapeCount,bothAirportStressLayout:'captured complexes positioned 9 miles apart; 32-mile viewport',dashedThresholdOffsetPixels:svgAlignment,mcoRunwayEndOffsets:alignment,simplification,panLongTasks:await page.evaluate(()=>window.panLongTasks),panGestureMedianMs:timings.sort((a,b)=>a-b)[10],panMeasurement:'4x CPU; complete touch gesture plus three two-frame settles and CDP overhead',surfaceLoads:await loads(),pageErrors:errors,externalRequests:external.length};
  await writeFile(join(outputDir,'verdict.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
} finally { await browser?.close(); if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true}); }
