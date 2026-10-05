import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezeTestClock } from './test-clock.mjs';

test('replay clock freezes Date.now, new Date and Date() together across UTC rollover', () => {
  const NativeDate = Date;
  let now = Date.parse('2026-10-04T23:59:59Z');
  const restore = freezeTestClock(() => now);
  try {
    for (let day = 0; day < 3; day++, now += 86400_000) {
      assert.equal(Date.now(), now);
      assert.equal(new Date().getTime(), now);
      assert.equal(Date(), new NativeDate(now).toString());
      assert(new Date() instanceof NativeDate);
      assert.equal(Date.parse('2026-10-02T18:00:00Z'), NativeDate.parse('2026-10-02T18:00:00Z'));
      assert.equal(Date.UTC(2026, 9, 2, 18), NativeDate.UTC(2026, 9, 2, 18));
      assert.equal(new Date(0).getTime(), 0);
      assert.equal(new Date('2026-10-02T18:00:00Z').toISOString(), '2026-10-02T18:00:00.000Z');
    }
  } finally { restore(); }
  assert.equal(Date, NativeDate);
});
