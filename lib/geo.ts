/**
 * Geodesic and circular-angle helpers.
 *
 * The angular helpers are deliberately kept separate from the ordinary numeric helpers: angles
 * wrap, and using ordinary arithmetic on them is the classic bug in GPS analytics. Everything
 * that averages, differences or interpolates a direction must go through these functions.
 */

export const EARTH_RADIUS_M = 6371008.8;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export interface LatLonLike {
  lat: number;
  lon: number;
}

/**
 * Great-circle distance in metres (haversine). Accurate to ~0.5% and numerically stable for the
 * short distances between consecutive GPS samples.
 */
export function haversineM(a: LatLonLike, b: LatLonLike): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLat = lat2 - lat1;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial great-circle bearing from `a` to `b` in degrees true, normalised to [0, 360).
 * Returns null for coincident points (no defined direction).
 */
export function bearingDeg(a: LatLonLike, b: LatLonLike): number | null {
  if (a.lat === b.lat && a.lon === b.lon) return null;
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalize360(Math.atan2(y, x) * RAD);
}

/** Wrap any angle into [0, 360). */
export function normalize360(deg: number): number {
  let r = deg % 360;
  if (r < 0) r += 360;
  // Snap values that are a floating-point hair away from a full turn, so that a circular mean of
  // e.g. 350° and 10° returns 0 and not 359.99999999999994.
  if (r >= 360 || r < 1e-9) r = 0;
  return r;
}

/** Wrap an angle into [-180, 180). */
export function normalize180(deg: number): number {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
}

/** Signed shortest difference `a - b` in degrees, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = normalize180(a - b);
  return d === -180 ? 180 : d;
}

/** Absolute shortest angular distance between two directions, in [0, 180]. */
export function angleDiffAbs(a: number, b: number): number {
  return Math.abs(angleDelta(a, b));
}

/** Linear interpolation of an angle along the shortest path. `f` in [0, 1]. */
export function lerpAngle(a: number, b: number, f: number): number {
  return normalize360(a + angleDelta(b, a) * f);
}

/**
 * Circular mean of directions, computed on unit vectors so it is independent of the arbitrary
 * 0°/360° cut. Returns null for an empty list.
 */
export function circularMeanDeg(angles: readonly number[]): number | null {
  if (angles.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos(a * DEG);
    y += Math.sin(a * DEG);
  }
  if (Math.hypot(x, y) < 1e-9) return null; // perfectly balanced, mean is undefined
  return normalize360(Math.atan2(y, x) * RAD);
}

/** Resultant vector length (0..1). 1 = all directions identical, 0 = uniformly spread. */
export function circularConcentration(angles: readonly number[]): number {
  if (angles.length === 0) return 0;
  let x = 0;
  let y = 0;
  for (const a of angles) {
    x += Math.cos(a * DEG);
    y += Math.sin(a * DEG);
  }
  return Math.min(1, Math.hypot(x, y) / angles.length);
}

/** 1 - concentration: 0 when every direction is identical, 1 when uniformly spread. */
export function circularSpread(angles: readonly number[]): number {
  return 1 - circularConcentration(angles);
}

/** Arithmetic mean; null for an empty list. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Median of a list; null for an empty list. */
export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}

/** Simple percentile using linear interpolation between ranks. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Longitude-safe arithmetic centroid of a set of points. */
export function centroid(points: readonly LatLonLike[]): LatLonLike | null {
  if (points.length === 0) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const lat = p.lat * DEG;
    const lon = p.lon * DEG;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  const n = points.length;
  x /= n;
  y /= n;
  z /= n;
  const lon = Math.atan2(y, x) * RAD;
  const hyp = Math.hypot(x, y);
  const lat = Math.atan2(z, hyp) * RAD;
  return { lat, lon };
}

/** Move a point by a distance along a bearing. Used by the demo generator and wind arrows. */
export function destination(from: LatLonLike, bearing: number, distanceM: number): LatLonLike {
  const d = distanceM / EARTH_RADIUS_M;
  const lat1 = from.lat * DEG;
  const lon1 = from.lon * DEG;
  const brg = bearing * DEG;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 * RAD, lon: normalizeLon(lon2 * RAD) };
}

/** Wrap longitude into [-180, 180). */
export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** True when a coordinate is a plausible position (rejects 0/0 "null island" style garbage). */
export function isPlausiblePosition(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  // 0,0 in the Gulf of Guinea is what broken devices report; no foiling happens there.
  if (lat === 0 && lon === 0) return false;
  return true;
}
