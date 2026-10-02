export type ScreenPoint = { x: number; y: number };
export type ScreenBox = { left: number; top: number; width: number; height: number };

function expanded(box: ScreenBox, padding: number): ScreenBox {
  return { left: box.left - padding, top: box.top - padding, width: box.width + 2 * padding, height: box.height + 2 * padding };
}

/** Clip a segment to a screen rectangle, including segments with both ends offscreen. */
export function clipScreenSegment(a: ScreenPoint, b: ScreenPoint, box: ScreenBox): [ScreenPoint, ScreenPoint] | null {
  let enter = 0, exit = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.left], [dx, box.left + box.width - a.x], [-dy, a.y - box.top], [dy, box.top + box.height - a.y]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t); else exit = Math.min(exit, t);
    if (enter > exit) return null;
  }
  return [{ x: a.x + enter * dx, y: a.y + enter * dy }, { x: a.x + exit * dx, y: a.y + exit * dy }];
}

export function runwayChipLayout(input: {
  viewport: ScreenBox; chip: { width: number; height: number };
  threshold: ScreenPoint; runwayForward: ScreenPoint;
  approach: ScreenPoint[]; route: ScreenPoint[]; obstacles: ScreenBox[];
}): ScreenBox | null {
  const { viewport, chip, threshold, runwayForward, approach, route, obstacles } = input;
  const safe = { left: viewport.left + 8, top: viewport.top + 8, width: viewport.width - 16, height: viewport.height - 16 };
  const inside = (p: ScreenPoint) => p.x >= safe.left && p.x <= safe.left + safe.width && p.y >= safe.top && p.y <= safe.top + safe.height;
  if (!inside(threshold) || chip.width > safe.width || chip.height > safe.height) return null;
  const visible = approach.slice(1).flatMap((point, i) => clipScreenSegment(approach[i], point, viewport) ?? []);
  if (visible.length < 2) return null;
  const span = Math.hypot(Math.max(...visible.map(p => p.x)) - Math.min(...visible.map(p => p.x)), Math.max(...visible.map(p => p.y)) - Math.min(...visible.map(p => p.y)));
  if (span < 100) return null;

  const magnitude = Math.hypot(runwayForward.x, runwayForward.y);
  if (magnitude === 0) return null;
  const axis = { x: runwayForward.x / magnitude, y: runwayForward.y / magnitude };
  const normal = { x: -axis.y, y: axis.x };
  // The greatest lateral displacement identifies the downwind side. Straight-in
  // approaches use the same deterministic side until a safe nearby spot exists.
  const lateral = approach.map(p => (p.x - threshold.x) * normal.x + (p.y - threshold.y) * normal.y);
  const downwind = lateral.reduce((best, n) => Math.abs(n) > Math.abs(best) ? n : best, 0);
  const sign = downwind < 0 ? 1 : -1;
  const away = { x: normal.x * sign, y: normal.y * sign };
  const halfAcross = (Math.abs(away.x) * chip.width + Math.abs(away.y) * chip.height) / 2;
  const overlaps = (a: ScreenBox, b: ScreenBox) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
  for (const gap of [16, 28, 40]) {
    for (const along of [0, 24, -24, 48, -48, 72, -72]) {
      const distance = halfAcross + gap;
      const box = { left: threshold.x + away.x * distance + axis.x * along - chip.width / 2, top: threshold.y + away.y * distance + axis.y * along - chip.height / 2, ...chip };
      if (!inside({ x: box.left, y: box.top }) || !inside({ x: box.left + box.width, y: box.top + box.height })) continue;
      if (overlaps(box, { left: threshold.x - 12, top: threshold.y - 12, width: 24, height: 24 })) continue;
      if (obstacles.some(obstacle => overlaps(box, expanded(obstacle, 6)))) continue;
      const clearance = expanded(box, 10);
      if (route.slice(1).some((point, i) => clipScreenSegment(route[i], point, clearance))) continue;
      return box;
    }
  }
  // Hiding is safer than clamping the chip back over the runway or approach.
  return null;
}
