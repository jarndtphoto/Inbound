import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/components/filed-app.tsx',import.meta.url),'utf8');
const styles=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
const flightPages=source.slice(source.indexOf('function FlightPages'),source.indexOf('function wheelsDown'));

test('tracked-flight shell has no header, back control, or reserved header space',()=>{
  assert.doesNotMatch(flightPages,/<header|aria-label="Back to flight search"/);
  assert.doesNotMatch(flightPages,/Home & settings|story\.callsign|story\.origin\.iata} → \{story\.dest\.iata/);
});

test('tracked-flight search and recent chips remain off the flight shell',()=>{
  assert.doesNotMatch(flightPages,/id="flight-q"|placeholder="AA 1, UA 2814, N105NN"|recents\.map/);
});

test('fixed shell navigation follows content with Home first and five compact destinations',()=>{
  const mainEnd=flightPages.indexOf('</main>');
  const nav=flightPages.indexOf('<nav aria-label="Flight pages"');
  assert.ok(nav>mainEnd,'navigation follows the independently scrolling content');
  assert.match(flightPages,/grid-cols-5/);
  assert.ok(flightPages.indexOf('Home — flight search') < flightPages.indexOf('FLIGHT_TABS.map'));
  assert.match(flightPages,/<span>Home<\/span>/);
  assert.match(flightPages,/tab === "Route" \? "Map" : tab/);
  assert.match(flightPages,/min-h-12/);
  assert.match(flightPages,/pwa-bottom-nav/);
  assert.match(styles,/\.pwa-bottom-nav\s*\{[^}]*safe-area-inset-bottom/s);
  assert.doesNotMatch(flightPages,/min-h-14/);
});

test('briefing uses the page scroller and the welcome dialog keeps symmetric safe margins',()=>{
  const briefing=source.slice(source.indexOf('function BreakdownCard'),source.indexOf('function StagePager'));
  const dialog=source.slice(source.indexOf('function FlightWelcome'),source.indexOf('function InboundCard'));
  assert.doesNotMatch(briefing,/max-h-56|overflow-y-auto/);
  assert.match(dialog,/left-1\/2 top-1\/2 m-0 w-\[calc\(100%-2rem\)\]/);
  assert.match(dialog,/overflow-x-hidden/);
  assert.match(dialog,/safe-area-inset-top/);
  assert.match(dialog,/safe-area-inset-bottom/);
});

test('tracked-flight polling pauses while hidden and refreshes stale state on return',()=>{
  assert.match(flightPages,/document\\.visibilityState !== "visible"\\) return false/);
  assert.match(flightPages,/addEventListener\\("visibilitychange", refreshWhenVisible\\)/);
  assert.match(flightPages,/Date\\.now\\(\\) - storyQ\\.dataUpdatedAt > 2_500/);
  assert.match(flightPages,/void storyQ\\.refetch\\(\\)/);
});
