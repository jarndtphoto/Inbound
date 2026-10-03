// Actual traffic/detail components with local phase fixtures; no provider traffic.
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH may select an installed Chromium.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createServer} from 'node:http';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import {chromium} from 'playwright';
const dir=await mkdtemp(resolve('node_modules/.phase-ui-')),output=join(dir,'out');
let browser,server;
try{
  await writeFile(join(dir,'index.html'),'<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(dir,'entry.tsx'),`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {TrafficList} from ${JSON.stringify(resolve('src/components/traffic-list.tsx'))};
    import {AircraftDetail} from ${JSON.stringify(resolve('src/components/aircraft-detail.tsx'))};
    import {useAirside} from ${JSON.stringify(resolve('src/lib/store.ts'))};
    import {normalizedToLive} from ${JSON.stringify(resolve('src/lib/flight-data.ts'))};
    import ${JSON.stringify(resolve('src/styles.css'))};
    const now=Date.now()/1000,origin={lat:28.4294,lon:-81.3089},dest={lat:41.9786,lon:-87.9048,elevationFt:672};
    const pos={provider:'adsb',confidence:'high',hex:'a00011',callsign:'TEST11',registration:'N11',type:'B738',lat:41.9786,lon:-88.3048,onGround:false,seenAt:now,altFt:20000,vertFpm:-900,gsKt:250,track:90};
    const traffic=[[-900,20600,'TEST11','a00011'],[900,19400,'TEST12','a00012']].map(([rate,oldAlt,callsign,hex])=>({...normalizedToLive({...pos,vertFpm:rate,callsign,hex},{origin,dest,history:[{...pos,seenAt:now-40,altFt:oldAlt}]}),airline:'United',distNm:18,bearing:270}));
    useAirside.setState({rangeNm:38,selectedHex:null});
    createRoot(document.getElementById('root')).render(<main style={{padding:20,maxWidth:640,margin:'auto'}}><h1>Aircraft phase fixture</h1><TrafficList traffic={traffic}/><AircraftDetail traffic={traffic}/></main>);
  `);
  await build({root:dir,configFile:false,logLevel:'silent',publicDir:false,resolve:{alias:{'@':resolve('src')}},plugins:[{name:'scan-app',enforce:'pre',transform(code,id){if(id===resolve('src/styles.css'))return code+'\n@source '+JSON.stringify(resolve('src'))+';';}},react(),tailwind()],build:{outDir:output}});
  server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname,file=join(output,path==='/'?'index.html':path);res.setHeader('content-type',{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage']});
  const results=[];
  for(const [name,width,height] of [['phone',390,844],['desktop',1280,800]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[],blocked=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();blocked.push(route.request().url());return route.abort();});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByRole('button',{name:/TEST11/}).waitFor();
    assert.match(await page.locator('main').innerText(),/Descending/);assert.match(await page.locator('main').innerText(),/Climbing/);
    assert.doesNotMatch(await page.locator('main').innerText(),/Cruise/i);
    const shots=process.env.PHASE_SCREENSHOT_DIR||'/tmp/aircraft-phase';await mkdir(shots,{recursive:true});
    await page.screenshot({path:join(shots,`${name}-traffic.png`)});
    await page.getByRole('button',{name:/TEST11/}).click();await page.getByRole('heading',{name:'TEST11'}).waitFor();
    assert.match(await page.locator('main').innerText(),/-900 fpm/);await page.screenshot({path:join(shots,`${name}-descent-detail.png`)});
    await page.getByRole('button',{name:'Close',exact:true}).last().click();
    await page.getByRole('button',{name:/TEST12/}).click();await page.getByRole('heading',{name:'TEST12'}).waitFor();assert.match(await page.locator('main').innerText(),/\+900 fpm/);
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);results.push({viewport:name,labels:true,detailRates:true,noCruiseDuringDescent:true,externalRequests:0});await page.close();
  }
  console.log(JSON.stringify(results,null,2));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
