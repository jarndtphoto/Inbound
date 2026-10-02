import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { runwayChipLayout, type ScreenBox, type ScreenPoint } from "@/lib/runway-chip-layout";

export function ArrivalRunwayChip({ frameRef, geometryRef, threshold, runwayForward, approach, route, runway, reported, viewKey }: {
  frameRef: RefObject<HTMLDivElement | null>; geometryRef: RefObject<SVGGElement | null>;
  threshold: ScreenPoint; runwayForward: ScreenPoint; approach: ScreenPoint[]; route: ScreenPoint[];
  runway: string; reported: boolean; viewKey: string;
}) {
  const chipRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ScreenBox | null>(null);
  useLayoutEffect(() => {
    const frame = frameRef.current, group = geometryRef.current, chip = chipRef.current;
    if (!frame || !group || !chip) return;
    const update = () => {
      // getScreenCTM includes viewBox scaling, meet letterboxing, zoom and pan.
      const matrix = group.getScreenCTM();
      if (!matrix) { setPlacement(null); return; }
      const bounds = frame.getBoundingClientRect();
      const screen = (p: ScreenPoint) => {
        const result = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        return { x: result.x - bounds.left, y: result.y - bounds.top };
      };
      const origin = screen(threshold), forward = screen({ x: threshold.x + runwayForward.x, y: threshold.y + runwayForward.y });
      const chipBounds = chip.getBoundingClientRect();
      const obstacles = [...frame.querySelectorAll("[data-map-obstacle]")].map(element => {
        const box = element.getBoundingClientRect();
        return { left: box.left - bounds.left, top: box.top - bounds.top, width: box.width, height: box.height };
      });
      const next = runwayChipLayout({ viewport: { left: 0, top: 0, width: bounds.width, height: bounds.height },
        chip: { width: chipBounds.width, height: chipBounds.height }, threshold: origin,
        runwayForward: { x: forward.x - origin.x, y: forward.y - origin.y },
        approach: approach.map(screen), route: route.map(screen), obstacles });
      setPlacement(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    observer.observe(chip);
    // Re-measure when fonts finish loading; auto-width must use rendered text.
    let disposed = false;
    document.fonts.ready.then(() => { if (!disposed) update(); });
    return () => { disposed = true; observer.disconnect(); };
  }, [frameRef, geometryRef, threshold.x, threshold.y, runwayForward.x, runwayForward.y, approach, route, runway, reported, viewKey]);

  return <div ref={chipRef} data-expected-runway-label
    aria-hidden={!placement}
    className="expected-runway-chip pointer-events-none absolute whitespace-nowrap rounded-sm border border-border bg-bg/80 px-1.5 py-0.5 font-mono text-fg"
    style={{ left: placement?.left ?? 0, top: placement?.top ?? 0, visibility: placement ? "visible" : "hidden" }}>
    {reported ? "Reported" : "Expected"} Rwy {runway}
  </div>;
}
