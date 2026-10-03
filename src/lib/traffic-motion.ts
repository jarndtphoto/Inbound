import type { Traffic } from "./types";

/** Existing Airside classifier, moved verbatim from sky.ts. No new phase math. */
export function phaseOf(ac: {
  onGround: boolean;
  gsKt: number | null;
  altFt: number | null;
  vertFpm: number | null;
}): Traffic["phase"] {
  if (ac.onGround) return (ac.gsKt ?? 0) > 8 ? "taxi" : "parked";
  const v = ac.vertFpm ?? 0;
  const alt = ac.altFt ?? 0;
  if (v < -400 && alt < 8000) return "approach";
  if (v < -250) return "descent";
  if (v > 400 && alt < 12000) return "climb";
  return "cruise";
}
