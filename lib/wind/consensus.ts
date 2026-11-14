/**
 * How well do the nearest stations agree about the wind direction?
 *
 * A station ten kilometres away is not the wind at the spot, and the usual way to squeeze accuracy out
 * of that is to look at several of them. What that cannot do is *triangulate* a direction: triangulation
 * locates a point from bearings, and a wind direction is not a position. Averaging three bearings gives
 * a meaningless number; averaging three wind directions gives a slightly better one.
 *
 * So this is a vector mean, weighted by distance, of the directions the nearby stations actually
 * measured — plus the thing that matters more than the mean: **how far apart they are**. If the five
 * nearest agree within four degrees, the direction is solid and the distance hardly matters. If they
 * disagree by forty, no average will save it, and a rider deserves to see that rather than a confident
 * number built out of a scatter.
 *
 * Everything here is measured. Nothing is interpolated into a station that did not report.
 */

export interface DirectionReport {
  id: string;
  name: string;
  distanceKm: number | null;
  /** degrees the wind came FROM, or null when the station has no direction */
  dirFromDeg: number | null;
  /** m/s, or null */
  speedMps: number | null;
  observationCount: number;
}

export interface DirectionConsensus {
  /** distance-weighted vector mean of the agreeing stations, or null when nothing usable was reported */
  dirFromDeg: number | null;
  /** how many stations are in the agreeing group */
  used: number;
  /** how many reported a direction at all */
  reported: number;
  /** largest gap inside the agreeing group, degrees */
  spreadDeg: number | null;
  /**
   * True when the agreeing group is tight enough that picking any of them would have given the same
   * answer. The threshold is deliberately generous: 15° is a third of the width of the sector a rider
   * would call "the same wind".
   */
  agreed: boolean;
  /**
   * Stations that reported a direction but disagree with the agreeing group.
   *
   * Kept separate rather than folded into the average, and named rather than silently dropped: on the
   * rider's own session the three coastal stations agreed at 193-205° while an inland station at a
   * motorway reported 96°, at the same distance. Averaging all four would have produced a direction
   * that described none of them, and calling the whole set "disagreeing" would have thrown away three
   * good witnesses because of one bad one.
   */
  outliers: DirectionReport[];
}

/** Two stations this close are describing the same wind for practical purposes. */
const CLUSTER_DEG = 25;
const AGREE_DEG = 15;

/** Shortest signed difference between two bearings, in degrees, in [-180, 180). */
function delta(a: number, b: number): number {
  let d = a - b;
  while (d >= 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Weight falls off with distance, because a station twice as far away is a worse witness. The floor of
 * 1 km keeps a station sitting on the track from getting an infinite vote, and stations without a
 * reported distance (Holfuy publishes none) get a neutral vote rather than being dropped.
 */
function weightOf(distanceKm: number | null): number {
  return 1 / Math.max(1, (distanceKm ?? 10) ** 2);
}

export function directionConsensus(reports: readonly DirectionReport[]): DirectionConsensus {
  const usable = reports.filter((r) => r.dirFromDeg != null && r.observationCount > 0);
  if (usable.length === 0) {
    return { dirFromDeg: null, used: 0, reported: 0, spreadDeg: null, agreed: false, outliers: [] };
  }

  // The group that agrees with each other most often, anchored on a station rather than on a mean:
  // an anchor is a real measurement, while a mean can land between two camps and belong to neither.
  let anchor = usable[0];
  let support = -1;
  for (const candidate of usable) {
    const near = usable.filter(
      (r) => Math.abs(delta(r.dirFromDeg!, candidate.dirFromDeg!)) <= CLUSTER_DEG,
    ).length;
    // Ties go to the closer station, which is the better witness.
    if (near > support || (near === support && (candidate.distanceKm ?? 1e9) < (anchor.distanceKm ?? 1e9))) {
      anchor = candidate;
      support = near;
    }
  }
  const group = usable.filter(
    (r) => Math.abs(delta(r.dirFromDeg!, anchor.dirFromDeg!)) <= CLUSTER_DEG,
  );
  const outliers = usable.filter((r) => !group.includes(r));

  let x = 0;
  let y = 0;
  let total = 0;
  for (const r of group) {
    const w = weightOf(r.distanceKm);
    const rad = (r.dirFromDeg! * Math.PI) / 180;
    x += Math.cos(rad) * w;
    y += Math.sin(rad) * w;
    total += w;
  }
  if (total <= 0 || Math.hypot(x, y) < 1e-9) {
    return {
      dirFromDeg: null,
      used: group.length,
      reported: usable.length,
      spreadDeg: null,
      agreed: false,
      outliers,
    };
  }

  const mean = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  let spread = 0;
  for (const r of group) spread = Math.max(spread, Math.abs(delta(r.dirFromDeg!, mean)));

  return {
    dirFromDeg: mean,
    used: group.length,
    reported: usable.length,
    spreadDeg: spread,
    agreed: spread <= AGREE_DEG,
    outliers,
  };
}
