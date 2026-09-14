import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/components/filed-app.tsx',import.meta.url),'utf8');
const styles=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
const flightPages=source.slice(source.indexOf('function FlightPages'),source.indexOf('function wheelsDown'));

test('tracked-flight shell has only a compact back control above content',()=>{
  assert.match(flightPages,/aria-label="Back to flight search"/);
  assert.doesNotMatch(flightPages,/Home & settings|story\.callsign|story\.origin\.iata} → \{story\.dest\.iata/);
});

test('tracked-flight search and recent chips remain off the flight shell',()=>{
  assert.doesNotMatch(flightPages,/id="flight-q"|placeholder="AA 1, UA 2814, N105NN"|recents\.map/);
});

test('fixed shell navigation follows content with four accessible destinations',()=>{
  const mainEnd=flightPages.indexOf('</main>');
  const nav=flightPages.indexOf('<nav aria-label="Flight pages"');
  assert.ok(nav>mainEnd,'navigation follows the independently scrolling content');
  assert.match(flightPages,/grid-cols-4/);
  assert.match(flightPages,/tab === "Route" \? "Map" : tab/);
  assert.match(flightPages,/min-h-14/);
  assert.match(flightPages,/pwa-bottom-nav/);
  assert.match(styles,/\.pwa-bottom-nav\s*\{[^}]*safe-area-inset-bottom/s);
  assert.doesNotMatch(flightPages,/grid-cols-5/);
});
