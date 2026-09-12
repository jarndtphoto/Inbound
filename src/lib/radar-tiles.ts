/** RainViewer / OSM tile math. z is the zoom level. */

export function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number) {
  const s = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.min(0.9999, Math.max(-0.9999, s));
  return (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * 2 ** z;
}

export function tileXToLon(x: number, z: number) {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export type RadarTile = { z: number; x: number; y: number };

const MAX_TILES = 36;

function spanIndexes(a: number, b: number, n: number): number[] {
  const lo = Math.max(0, Math.min(Math.floor(a), Math.floor(b)));
  const hi = Math.min(n - 1, Math.max(Math.floor(a), Math.floor(b)));
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** Tiles that cover the projected view. Zoom drops until the count stays sane — never west-first crop. */
export function pickRadarTiles(
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
): RadarTile[] {
  const west = Math.min(minLon, maxLon);
  const east = Math.max(minLon, maxLon);
  const south = Math.min(minLat, maxLat);
  const north = Math.max(minLat, maxLat);
  for (const z of [6, 5, 4, 3]) {
    const n = 2 ** z;
    const xs = spanIndexes(lonToTileX(west, z), lonToTileX(east, z), n);
    const ys = spanIndexes(latToTileY(north, z), latToTileY(south, z), n);
    if (xs.length * ys.length > MAX_TILES && z > 3) continue;
    const tiles: RadarTile[] = [];
    for (const x of xs) {
      for (const y of ys) tiles.push({ z, x, y });
    }
    return tiles;
  }
  return [];
}
