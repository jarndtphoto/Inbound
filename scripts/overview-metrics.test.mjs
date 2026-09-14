import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../src/components/filed-app.tsx',import.meta.url),'utf8');
const strip=source.slice(source.indexOf('function TimesStrip'),source.indexOf('function Freshness'));
const stat=source.slice(source.indexOf('function Stat'),source.indexOf('function BreakdownCard'));

test('remaining and flown cards are compact without shrinking their values',()=>{
  assert.doesNotMatch(strip,/aspect-square|sm:min-h-32/);
  assert.equal((strip.match(/min-h-28 min-w-0 flex-col/g)||[]).length,2);
  assert.equal((strip.match(/font-display text-2xl/g)||[]).length,2);
  assert.match(strip,/break-words[^>]*>\{liveFresh \? formatDuration/);
  assert.match(strip,/break-words[^>]*>\{elapsed \? formatDuration/);
});

test('live flight card uses moderate compact spacing',()=>{
  assert.match(stat,/px-3 py-1\.5/);
  assert.match(stat,/mt-0\.5 flex items-center/);
  assert.match(stat,/text-xs leading-tight text-muted/);
});
