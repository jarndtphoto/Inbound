// Actual map component; stories exported by route-memory-replay.test.mjs.
// All browser traffic stays local, including oceanic and approach gap views.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createServer} from 'node:http';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import {chromium} from 'playwright';
if(!process.env.ROUTE_FIXTURE_STORIES) throw Error('Set ROUTE_FIXTURE_STORIES to the mocked server replay story export');
const stories=JSON.parse(await readFile(process.env.ROUTE_FIXTURE_STORIES,'utf8'));
const dir=await mkdtemp(resolve('node_modules/.route-continuity-ui-')),output=join(dir,'out');
const shots=process.env.ROUTE_SCREENSHOT_DIR||'/workspace/screenshots/route-continuity';
let browser,server;
try{
  await writeFile(join(dir,'stories.json'),JSON.stringify(stories));
  await writeFile(join(dir,'index.html'),'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(dir,'entry.tsx'),`
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import {RouteMap} from ${JSON.stringify(resolve('src/components/route-map.tsx'))};
    import {useFiled} from ${JSON.stringify(resolve('src/lib/store.ts'))};
    import stories from './stories.json'; import ${JSON.stringify(resolve('src/styles.css'))};
    useFiled.setState({weatherOn:false});
    function App(){const [name,setName]=useState('first');const story=stories[name];Date.now=()=>story.fetchedAt;
      return <QueryClientProvider client={new QueryClient()}><main style={{height:'100dvh',maxWidth:900,margin:'auto',display:'flex',flexDirection:'column'}}>
        <h1 className="p-2 text-sm">Local route continuity replay · {story.origin.iata} → {story.dest.iata}</h1>
        <div className="flex gap-1 p-2">{[['first','Observed'],['gap','Oceanic gap'],['recovered','Recovered'],['approachGap','Approach gap']].map(([key,label])=><button className="min-h-11 rounded border border-border px-2 text-xs" key={key} onClick={()=>setName(key)}>{label}</button>)}</div>
        <section style={{flex:1,minHeight:0}}><RouteMap story={story} fixedViewport /></section></main></QueryClientProvider>;
    }createRoot(document.getElementById('root')).render(<App/>);
  `);
  await build({root:dir,configFile:false,logLevel:'silent',publicDir:false,resolve:{alias:{'@':resolve('src')}},plugins:[{name:'scan-app',enforce:'pre',transform(code,id){if(id===resolve('src/styles.css'))return code+'\n@source '+JSON.stringify(resolve('src'))+';';}},react(),tailwind()],build:{outDir:output}});
  server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=join(output,path==='/'?'index.html':path);res.setHeader('content-type',{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
  await mkdir(shots,{recursive:true});const results=[];
  for(const [name,width,height] of [['phone',390,844],['desktop',1280,800]]){
    const page=await browser.newPage({viewport:{width,height},isMobile:name==='phone',hasTouch:name==='phone'}),errors=[],blocked=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();blocked.push(r.request().url());return r.abort();});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.locator('[data-map-aircraft]').waitFor();
    await page.getByRole('button',{name:'Oceanic gap',exact:true}).click();
    await page.locator('[data-route-progress-source="last_known"]').waitFor();
    assert.equal(await page.locator('[data-map-aircraft]').count(),0);
    assert((await page.locator('[data-route-stroke="flown"]').count())>0);
    assert.match(await page.locator('main').innerText(),/Last known progress · 2 min ago/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:join(shots,`${name}-oceanic-gap.png`)});
    await page.getByRole('button',{name:'Recovered',exact:true}).click();await page.locator('[data-map-aircraft]').waitFor();
    assert.equal(await page.locator('[data-route-progress-source="observed"]').count(),1);
    await page.getByRole('button',{name:'Approach gap',exact:true}).click();
    await page.getByText('Approach plan · stale',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-map-aircraft]').count(),0);
    assert((await page.locator('[data-route-stroke="projected"][stroke-dasharray="8 5"]').count())>0);
    await page.getByText('Map details',{exact:true}).click();
    await page.getByText('Approach plan is stale and held from the last known point until a fresh observation arrives.',{exact:true}).waitFor();
    await page.screenshot({path:join(shots,`${name}-approach-gap.png`)});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
    results.push({viewport:name,lastKnownAge:true,observedTrack:true,noGapAircraft:true,freshRecovery:true,heldApproach:true,horizontalOverflow:false,pageErrors:errors,externalRequests:0});await page.close();
  }
  await writeFile(join(shots,'verdict.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
