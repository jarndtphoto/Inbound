import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipScreenSegment, runwayChipLayout, type ScreenPoint } from "./runway-chip-layout.ts";

const threshold = { x: 210, y: 280 };
const approach = [{ x: 310, y: 360 }, { x: 60, y: 360 }, { x: 60, y: 280 }, threshold];
const base = { viewport: { left: 0, top: 0, width: 390, height: 630 }, chip: { width: 118, height: 21 },
  threshold, runwayForward: { x: 1, y: 0 }, approach, route: approach,
  obstacles: [{ left: 198, top: 268, width: 26, height: 38 }, { left: 298, top: 350, width: 24, height: 24 }] };

describe("runway chip screen layout", () => {
  for (const width of [375, 390]) it(`places the chip opposite downwind without crossing a line or airport at ${width}px`, () => {
    const box = runwayChipLayout({ ...base, viewport: { ...base.viewport, width } });
    assert.ok(box);
    assert.ok(box.top + box.height < threshold.y - 12);
    assert.ok(box.left >= 8 && box.left + box.width <= width - 8);
    for (let i = 1; i < approach.length; i++) assert.equal(clipScreenSegment(approach[i - 1], approach[i], box), null);
  });
  it("hides a tiny overview approach and an offscreen threshold", () => {
    const tiny = approach.map(p => ({ x: threshold.x + (p.x - threshold.x) / 4, y: threshold.y + (p.y - threshold.y) / 4 }));
    assert.equal(runwayChipLayout({ ...base, approach: tiny }), null);
    assert.equal(runwayChipLayout({ ...base, threshold: { x: -2, y: 280 } }), null);
  });
  it("repositions for zoom and pan instead of clamping across the approach", () => {
    const transform = (p: ScreenPoint) => ({ x: p.x * 2 - 220, y: p.y * 2 - 400 });
    const box = runwayChipLayout({ ...base, threshold: transform(threshold), approach: approach.map(transform), route: approach.map(transform), obstacles: [] });
    assert.ok(box);
    assert.ok(box.top + box.height < transform(threshold).y - 12);
    assert.notEqual(box.top, runwayChipLayout(base)?.top);
    for (let i = 1; i < approach.length; i++) assert.equal(clipScreenSegment(transform(approach[i - 1]), transform(approach[i]), box), null);
  });
  it("keeps the aircraft and overlay pills clear, or hides when no safe space remains", () => {
    const first = runwayChipLayout(base);
    assert.ok(first);
    const next = runwayChipLayout({ ...base, obstacles: [...base.obstacles, first] });
    assert.ok(!next || next.left !== first.left || next.top !== first.top);
    assert.equal(runwayChipLayout({ ...base, obstacles: [base.viewport] }), null);
  });
  it("handles segments crossing the screen with both endpoints outside", () => {
    assert.deepEqual(clipScreenSegment({ x: -100, y: 280 }, { x: 500, y: 280 }, base.viewport), [{ x: 0, y: 280 }, { x: 390, y: 280 }]);
  });
  it("uses the other side for a mirrored downwind", () => {
    const mirrored = approach.map(p => ({ x: p.x, y: 2 * threshold.y - p.y }));
    const box = runwayChipLayout({ ...base, approach: mirrored, route: mirrored });
    assert.ok(box);
    assert.ok(box.top > threshold.y + 12);
  });
});
