// Run with node scripts/verify-flight-search.mjs (installed Playwright Chromium,
// or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). Actual UI, fixture RPCs, no providers.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join, extname } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { chromium } from 'playwright';

const directory = await mkdtemp(resolve('node_modules/.flight-search-ui-'));
const output = join(directory, 'dist');
const mocks = new Map([
  [resolve('src/lib/story.ts'), 'export const getFlightStory = options => window.searchFixture.load(options);'],
  [resolve('src/lib/brief.ts'), 'export const briefRide = async () => ({ok:false});'],
  [resolve('src/lib/baggage.ts'), 'export const getBaggage = async () => ({status:"unavailable",checkedAt:Date.now()});'],
  [resolve('src/lib/ground-position.ts'), 'export const getGroundPosition = async () => null;'],
  [resolve('src/lib/airport-surface.ts'), 'export const getAirportSurfaceCached = async () => null;'],
]);
let browser, server;
const results = [];
try {
  await writeFile(join(directory, 'index.html'), '<!doctype html><html lang="en" style="height:100%"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body style="height:100%;margin:0"><div id="root" style="height:100%"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(directory, 'entry.tsx'), `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import {createRootRoute,createRoute,createRouter,RouterProvider,Outlet} from '@tanstack/react-router';
    import {FiledApp} from ${JSON.stringify(resolve('src/components/filed-app.tsx'))};
    import {polishStory} from ${JSON.stringify(resolve('scripts/fixtures/presentation-polish.mjs'))};
    import ${JSON.stringify(resolve('src/styles.css'))};
    const client = new QueryClient();
    window.searchFixture = {client,mode:localStorage.getItem('fixture-mode') || 'pending',requests:0,aborts:0,queries:[],load({data,signal}) {
      this.requests++;this.queries.push(data?.q);
      if(this.mode==='notfound') return Promise.reject(new Error('Flight not found'));
      if(this.mode==='temporary') return Promise.reject(new Error('Current flight route unavailable: schedule provider returned HTTP 402; FlightStats unavailable'));
      if(this.mode==='loaded') return Promise.resolve({...polishStory(),fetchedAt:Date.now()});
      if(this.mode==='slow') return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>resolve({...polishStory(),fetchedAt:Date.now()}),28_000);
        signal.addEventListener('abort',()=>{clearTimeout(timer);this.aborts++;reject(signal.reason);},{once:true});
      });
      return new Promise((resolve,reject) => signal.addEventListener('abort',()=>{this.aborts++;reject(signal.reason);},{once:true}));
    }};
    const root = createRootRoute({component:()=> <QueryClientProvider client={client}><Outlet/></QueryClientProvider>});
    const route = createRoute({getParentRoute:()=>root,path:'/',component:FiledApp});
    const router = createRouter({routeTree:root.addChildren([route])});
    createRoot(document.getElementById('root')).render(<RouterProvider router={router}/>);
  `);
  await build({ root: directory, configFile: false, logLevel: 'silent', publicDir: false,
    resolve: { alias: { '@': resolve('src') } }, plugins: [
      { name: 'fixture-rpcs', enforce: 'pre', resolveId(source) {
        const path = source.startsWith('@/') ? resolve('src', source.slice(2)) : source;
        const candidate = mocks.has(path) ? path : path + '.ts';
        if (mocks.has(candidate)) return '\0fixture:' + candidate;
      }, load(id) { if (id.startsWith('\0fixture:')) return mocks.get(id.slice(9)); },
      transform(code, id) {
        // The fixture root is inside ignored node_modules; scan the actual app.
        if (id === resolve('src/styles.css')) return code + '\n@source ' + JSON.stringify(resolve('src')) + ';\n';
      } }, react(), tailwind(),
    ], build: { outDir: output } });
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const file = join(output, path === '/' ? 'index.html' : path);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
      res.setHeader('content-type', type); res.end(await readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const [name, width, height] of [['mobile', 390, 844], ['desktop', 1280, 800]]) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(); const errors = [], blocked = [];
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const host = new URL(route.request().url()).hostname;
      if (host === '127.0.0.1') return route.continue();
      blocked.push(host); return route.abort();
    });
    await page.clock.install({ time: new Date('2026-10-03T14:00:00Z') });

    // URL state is applied before stored-query hydration. Invalid links stay on
    // a corrective search and cannot start a story request.
    await page.goto(url + '?flight=NOT-A-FLIGHT&tab=map');
    await page.getByLabel('Flight number', { exact: true }).waitFor();
    assert.match(await page.getByRole('alert').innerText(), /couldn't find NOT-A-FLIGHT/i);
    assert.equal(await page.evaluate(() => window.searchFixture.requests), 0);
    await page.evaluate(() => {
      localStorage.setItem('filed-q-v1', 'AA1');
      localStorage.setItem('filed-recents-v1', JSON.stringify(['AA1']));
      localStorage.setItem('fixture-mode', 'loaded');
    });

    // Every passenger tab survives a reload. The stored AA1 never gets a
    // request, and tab navigation replaces the current history entry.
    await page.goto(url + '?flight=UA219&tab=map');
    await page.getByRole('navigation', { name: 'Flight pages' }).waitFor();
    const closeWelcome = async () => {
      const close = page.getByRole('button', { name: 'Close flight briefing' });
      if (await close.count()) await close.click();
    };
    await closeWelcome();
    await page.waitForFunction(() => new URL(location.href).searchParams.get('date') === '2026-10-03');
    assert.equal(await page.locator('#panel-Route').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => [...window.searchFixture.queries]), ['UA219']);
    const beforeTabHistory = await page.evaluate(() => history.length);
    await page.evaluate(() => {
      const replace = history.replaceState.bind(history); window.replaceCalls = 0;
      history.replaceState = (...args) => { window.replaceCalls++; return replace(...args); };
    });
    await page.getByRole('button', { name: 'Weather', exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get('tab'), 'weather');
    assert.equal(await page.evaluate(() => history.length), beforeTabHistory);
    assert.equal(await page.evaluate(() => window.replaceCalls), 1);
    for (const [label, slug, panel] of [['Overview', 'overview', 'Overview'], ['Map', 'map', 'Route'], ['Weather', 'weather', 'Weather'], ['Briefing', 'briefing', 'Briefing']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('tab'), slug);
      await page.reload(); await page.getByRole('navigation', { name: 'Flight pages' }).waitFor(); await closeWelcome();
      assert.equal(await page.locator(`#panel-${panel}`).isVisible(), true);
      assert.ok((await page.evaluate(() => window.searchFixture.queries)).every(query => query === 'UA219'));
    }

    // A dated link may not display today's same-number flight, and its explicit
    // not-found result stops polling while keeping a search input available.
    await page.goto(url + '?flight=UA219&tab=overview&date=2026-10-02');
    const oldLinkAlert = page.getByRole('alert'); await oldLinkAlert.waitFor();
    assert.match(await oldLinkAlert.innerText(), /couldn't find UA219/i);
    assert.equal(await oldLinkAlert.getByLabel('Flight number').inputValue(), 'UA219');
    const oldLinkRequests = await page.evaluate(() => window.searchFixture.requests);
    await page.clock.fastForward(65_000);
    assert.equal(await page.evaluate(() => window.searchFixture.requests), oldLinkRequests);
    await page.evaluate(() => { localStorage.setItem('fixture-mode', 'pending'); localStorage.removeItem('filed-story-cache-v9'); });
    await page.goto(url);
    await page.getByRole('button', { name: 'Track my flight', exact: true }).click();
    const requests = () => page.evaluate(() => window.searchFixture.requests);
    const kept = async q => {
      await page.getByLabel('Flight number', { exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.getByLabel('Flight number', { exact: true }).inputValue(), q);
      await page.waitForFunction(() => !window.history.state.inboundFlightQuery);
    };
    const flat = async () => {
      const count = await requests();
      await page.clock.fastForward(65_000);
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
      await page.clock.fastForward(20_000); assert.equal(await requests(), count);
    };
    const start = async (q, mode) => {
      await page.evaluate(mode => { window.searchFixture.mode = mode; }, mode);
      await page.getByLabel('Flight number', { exact: true }).fill(q);
      await page.getByRole('button', { name: 'Track my flight →', exact: true }).click();
    };
    const screenshot = async label => {
      if (!process.env.FLIGHT_SEARCH_EVIDENCE_DIR) return;
      assert.ok((await page.locator('.journey-header').boundingBox()).y >= 0, 'flight header stays visible');
      await mkdir(process.env.FLIGHT_SEARCH_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.FLIGHT_SEARCH_EVIDENCE_DIR, `${name}-${label}.png`) });
    };
    await start('US5558', 'pending');
    await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    await screenshot('loading');
    const back = page.locator('.journey-header').getByRole('button', { name: 'Back to search', exact: true });
    const bounds = await back.boundingBox(); assert.ok(bounds.width >= 44 && bounds.height >= 44);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await kept('US5558'); await flat();
    assert.equal(await page.evaluate(() => window.searchFixture.aborts), 1);
    assert.equal(await page.evaluate(() => window.searchFixture.client.getQueryCache().find({queryKey:['story','US5558'],exact:true}) === undefined), true);

    await start('US5558', 'pending'); await back.waitFor(); await back.click(); await kept('US5558'); await flat();
    await start('US5558', 'notfound');
    const alert = page.getByRole('alert'); await alert.waitFor();
    assert.match(await alert.innerText(), /We couldn't find US5558\. Check the flight number\./);
    await screenshot('not-found'); await flat();
    const failed = await requests(); await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.waitForFunction(count => window.searchFixture.requests === count + 1, failed);
    await alert.waitFor(); await alert.getByRole('button', { name: 'Back to search', exact: true }).click();
    await kept('US5558'); await flat();

    await start('US5558', 'pending'); await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    const beforeSoft={requests:await requests(),aborts:await page.evaluate(()=>window.searchFixture.aborts)};
    await page.clock.fastForward(19_000); assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).count(), 1);
    await page.clock.fastForward(1_100); await page.getByRole('heading',{name:'Still looking…',exact:true}).waitFor();
    assert.equal(await requests(),beforeSoft.requests);assert.equal(await page.evaluate(()=>window.searchFixture.aborts),beforeSoft.aborts);
    assert.equal(await alert.count(),0);await screenshot('still-looking');
    await page.getByRole('button',{name:'Cancel',exact:true}).click();await kept('US5558');await flat();

    await start('UA219','slow');await page.getByRole('button',{name:'Cancel',exact:true}).waitFor();
    const slowCount=await requests(),slowAborts=await page.evaluate(()=>window.searchFixture.aborts);
    await page.clock.fastForward(20_100);await page.getByRole('heading',{name:'Still looking…',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.searchFixture.aborts),slowAborts);
    await page.clock.fastForward(8_000);await page.getByRole('button',{name:'Close flight briefing'}).click();
    await page.getByRole('navigation',{name:'Flight pages'}).waitFor();
    assert.equal(await requests(),slowCount,'a valid 28-second load uses one request');
    await back.click();await kept('UA219');await flat();
    await page.evaluate(()=>localStorage.removeItem('filed-story-cache-v9'));

    await start('WN421','temporary');await alert.waitFor();const temporaryCount=await requests();
    assert.match(await alert.innerText(),/Flight data is temporarily unavailable/);
    assert.doesNotMatch(await alert.innerText(),/couldn't find/);await screenshot('temporary');
    for(let i=1;i<=4;i++){
      await page.clock.fastForward(30_100);await page.waitForFunction(count=>window.searchFixture.requests===count,temporaryCount+i);
    }
    await flat();assert.equal(await requests(),temporaryCount+4,'initial request plus four slow retries');
    await alert.getByRole('button',{name:'Back to search',exact:true}).click();await kept('WN421');await flat();

    await start('US5558', 'pending'); await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor();
    await page.goBack(); await kept('US5558'); await flat();
    await page.goForward(); await back.waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await kept('US5558'); await flat();

    await start('UA219', 'notfound'); await alert.waitFor();
    await page.evaluate(() => { window.searchFixture.mode = 'loaded'; });
    await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Close flight briefing' }).click();
    await page.getByRole('navigation', { name: 'Flight pages' }).waitFor();
    assert.equal(await back.count(), 1);
    const loaded = await requests(); await page.clock.fastForward(4_100);
    assert.ok(await requests() > loaded, 'loaded flight still polls');
    await page.getByRole('button', { name: 'Weather', exact: true }).click();
    assert.equal(await page.locator('#panel-Weather').isVisible(), true);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await screenshot('loaded'); await page.getByRole('button', { name: 'Home — flight search' }).click();
    await kept('UA219'); await flat();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    assert.ok(!blocked.some(host => /flightaware|flightstats|fr24|flightradar|adsb/.test(host)));
    results.push({ viewport: name, loadingCancel: true, loadingBack: true, errorBack: true, textKept: true,
      postExitRequestsFlat: true, notFoundNoRetry: true, stillLookingMs: 20_000, slowValidLoadMs:28_000, temporaryAttempts:5, temporaryRetryMs:30_000, explicitRetry: true,
      browserBackForward: true, loadedPollingAndTabs: true, pageErrors: errors, providerRequests: 0 });
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, fixtureOnly: true, results }, null, 2));
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error({ url: page.url(), body: await page.locator('body').innerText().catch(() => ''), fixture: await page.evaluate(() => window.searchFixture && ({requests:window.searchFixture.requests,aborts:window.searchFixture.aborts})).catch(() => null) });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
