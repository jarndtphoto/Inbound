import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/components/filed-app.tsx',import.meta.url),'utf8');
const strip=source.slice(source.indexOf('function TimesStrip'),source.indexOf('function Freshness'));
const stat=source.slice(source.indexOf('function Stat'),source.indexOf('function BreakdownCard'));

const css=readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
const details=source.slice(source.indexOf('function OverviewDetails'),source.indexOf('function kindLabel'));

test('live timing is visible before arrival details and outside the disclosure',()=>{
  assert.ok(details.indexOf('{timing}') < details.indexOf('<dl className="arrival-details">'));
  assert.ok(details.indexOf('{timing}') < details.indexOf('<OverviewDisclosure id="flight"'));
  assert.equal((details.match(/\{timing\}/g)||[]).length,1);
});

test('timing uses two unboxed columns and an optional inline live position',()=>{
  assert.equal((strip.match(/className="timing-values"/g)||[]).length,3);
  assert.match(css,/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css,/\.timing-number[^}]*white-space: nowrap/);
  assert.doesNotMatch(strip,/<Stat|Live timing & position/);
  assert.match(strip,/showLiveFlight \? \(/);
  assert.match(strip,/className="timing-position"/);
});

test('live flight card uses moderate compact spacing',()=>{
  assert.match(stat,/px-3 py-1\.5/);
  assert.match(stat,/mt-0\.5 flex items-center/);
  assert.match(stat,/text-xs leading-tight text-muted/);
});
