/**
 * Session metrics.
 *
 * Everything is computed from the timestamps and the actual GPS displacement between samples.
 * No function here assumes a fixed sampling interval: a watch that drops to 0.5 Hz mid-session
 * must not change the reported averages, and the time-weighted helpers below guarantee that.
 */

import { circularMeanDeg, circularSpread, percentile } from "./geo";
import type {
  DirectionStats,
  EnrichedPoint,
  HistogramBucket,
  SessionMetrics,
} from "./types";

/** Threshold (degrees of true wind angle) below which a sample counts as upwind. */
export const UPWIND_TWA_MAX = 70;
/** Threshold above which a sample counts as downwind. */
export const DOWNWIND_TWA_MIN = 110;

/** An interval between two consecutive samples, with trapezoidal value pairs. */
export interface Interval {
  /** index of the sample that *ends* the interval */
  i: number;
  /** seconds */
  dt: number;
  /** metres */
  dd: number;
  from: EnrichedPoint;
  to: EnrichedPoint;
  /** mean of a per-point value across the interval, or null when either side is missing */
  mid(value: (p: EnrichedPoint) => number | null): number | null;
}

/** Convenience factory for an interval. Used by `forEachInterval` and the segment classifier. */
export function intervalAt(
  points: readonly EnrichedPoint[],
  i: number,
): Interval | null {
  if (i < 1 || i >= points.length) return null;
  const from = points[i - 1];
  const to = points[i];
  const dt = (to.t - from.t) / 1000;
  if (dt <= 0) return null;
  return {
    i,
    dt,
    dd: to.dd,
    from,
    to,
    mid(value: (p: EnrichedPoint) => number | null) {
      const a = value(from);
      const b = value(to);
      if (a == null && b == null) return null;
      if (a == null) return b;
      if (b == null) return a;
      return (a + b) / 2;
    },
  };
}

/** Iterate the intervals between consecutive samples. The first sample has no interval. */
export function forEachInterval(
  points: readonly EnrichedPoint[],
  cb: (interval: Interval) => void,
): void {
  for (let i = 1; i < points.length; i++) {
    const iv = intervalAt(points, i);
    if (iv) cb(iv);
  }
}

/**
 * Time-weighted mean: each interval contributes in proportion to its duration, so a 5 second
 * gap cannot outweigh five 1 second samples. Returns null when nothing is usable.
 */
export function timeWeightedMean(
  points: readonly EnrichedPoint[],
  value: (p: EnrichedPoint) => number | null,
  filter?: (interval: Interval) => boolean,
): number | null {
  let num = 0;
  let den = 0;
  forEachInterval(points, (iv) => {
    if (filter && !filter(iv)) return;
    const v = iv.mid(value);
    if (v == null) return;
    num += v * iv.dt;
    den += iv.dt;
  });
  return den > 0 ? num / den : null;
}

/**
 * Maximum speed, using a rolling mean whose window is a duration (not a sample count) so it works
 * with any sampling rate. A single noisy sample cannot become the session maximum.
 */
export function smoothedMaxSpeed(
  points: readonly EnrichedPoint[],
  windowS = 3,
): number | null {
  const samples: { t: number; speed: number }[] = [];
  for (const p of points) {
    if (p.gap || !p.moving || p.speed == null) continue;
    samples.push({ t: p.t, speed: p.speed });
  }
  if (samples.length === 0) return null;
  if (samples.length < 3) return Math.max(...samples.map((s) => s.speed));

  const half = (windowS * 1000) / 2;
  let best = 0;
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    let n = 0;
    // Walk outwards while we stay inside the half window. Samples are time ordered.
    for (let j = i; j >= 0 && samples[i].t - samples[j].t <= half; j--) {
      sum += samples[j].speed;
      n++;
    }
    for (let j = i + 1; j < samples.length && samples[j].t - samples[i].t <= half; j++) {
      sum += samples[j].speed;
      n++;
    }
    const avg = sum / n;
    if (avg > best) best = avg;
  }
  return best;
}

/** Histogram of time spent in each speed bucket, weighted by actual interval duration. */
export function speedHistogram(
  points: readonly EnrichedPoint[],
  bucketWidth = 0.5,
  maxMps = 20,
): HistogramBucket[] {
  const count = Math.ceil(maxMps / bucketWidth);
  const buckets: HistogramBucket[] = Array.from({ length: count }, (_, i) => ({
    fromMps: i * bucketWidth,
    toMps: (i + 1) * bucketWidth,
    timeS: 0,
  }));
  forEachInterval(points, (iv) => {
    if (!iv.to.moving) return;
    const v = iv.mid((p) => (p.gap ? null : p.speed));
    if (v == null) return;
    const idx = Math.min(count - 1, Math.floor(v / bucketWidth));
    if (idx >= 0) buckets[idx].timeS += iv.dt;
  });
  return buckets;
}

/** Histogram of time spent at each VMG value (metres per second). */
export function vmgHistogram(
  points: readonly EnrichedPoint[],
  direction: "up" | "down",
  bucketWidth = 0.5,
  maxMps = 10,
): HistogramBucket[] {
  const count = Math.ceil(maxMps / bucketWidth);
  const buckets: HistogramBucket[] = Array.from({ length: count }, (_, i) => ({
    fromMps: i * bucketWidth,
    toMps: (i + 1) * bucketWidth,
    timeS: 0,
  }));
  forEachInterval(points, (iv) => {
    if (!iv.to.moving) return;
    const v =
      direction === "up" ? iv.mid((p) => p.vmgUpMps) : iv.mid((p) => p.vmgDownMps);
    if (v == null || v <= 0) return;
    const idx = Math.min(count - 1, Math.floor(v / bucketWidth));
    if (idx >= 0) buckets[idx].timeS += iv.dt;
  });
  return buckets;
}

/** Aggregate stats for one sailing direction (upwind or downwind). */
export function directionStats(
  points: readonly EnrichedPoint[],
  direction: "upwind" | "downwind",
): DirectionStats {
  const inDirection = (p: EnrichedPoint): boolean => {
    if (p.twa == null) return false;
    return direction === "upwind" ? p.twa <= UPWIND_TWA_MAX : p.twa >= DOWNWIND_TWA_MIN;
  };

  let timeS = 0;
  let distanceM = 0;
  let maxSpeed: number | null = null;
  let bestVmg: number | null = null;

  forEachInterval(points, (iv) => {
    if (!iv.to.moving) return;
    const twa = iv.mid((p) => p.twa);
    if (twa == null) return;
    if (direction === "upwind" ? twa > UPWIND_TWA_MAX : twa < DOWNWIND_TWA_MIN) return;
    timeS += iv.dt;
    distanceM += iv.dd;
    const speed = iv.mid((p) => (p.gap ? null : p.speed));
    if (speed != null && (maxSpeed == null || speed > maxSpeed)) maxSpeed = speed;
    const vmg = iv.mid((p) => (direction === "upwind" ? p.vmgUpMps : p.vmgDownMps));
    if (vmg != null && (bestVmg == null || vmg > bestVmg)) bestVmg = vmg;
  });

  const avgVmg = timeWeightedMean(
    points,
    (p) => (direction === "upwind" ? p.vmgUpMps : p.vmgDownMps),
    (iv) => iv.to.moving && inDirection(iv.to) && inDirection(iv.from),
  );

  return {
    timeS,
    distanceM,
    avgSpeedMps: timeS > 0 ? distanceM / timeS : null,
    maxSpeedMps: maxSpeed,
    avgVmgMps: avgVmg,
    bestVmgMps: bestVmg,
  };
}

/** Everything the dashboard shows in its headline metric block. */
export function computeSessionMetrics(points: readonly EnrichedPoint[]): SessionMetrics {
  if (points.length === 0) {
    return {
      distanceM: 0,
      movingTimeS: 0,
      elapsedTimeS: 0,
      avgSpeedMps: null,
      maxSpeedMps: null,
      p10SpeedMps: null,
      startedAt: 0,
      endedAt: 0,
      speedBuckets: [],
    };
  }

  const first = points[0];
  const last = points[points.length - 1];
  const distanceM = last.dist - first.dist;

  let movingTimeS = 0;
  const movingSpeeds: number[] = [];
  forEachInterval(points, (iv) => {
    if (!iv.to.moving) return;
    movingTimeS += iv.dt;
    const v = iv.mid((p) => (p.gap ? null : p.speed));
    if (v != null) movingSpeeds.push(v);
  });

  return {
    distanceM,
    movingTimeS,
    elapsedTimeS: (last.t - first.t) / 1000,
    avgSpeedMps: movingTimeS > 0 ? distanceM / movingTimeS : null,
    maxSpeedMps: smoothedMaxSpeed(points),
    p10SpeedMps: percentile(movingSpeeds, 10),
    startedAt: first.t,
    endedAt: last.t,
    speedBuckets: speedHistogram(points),
  };
}

/** Mean heading across a slice, plus how spread out it is (0 = straight line). */
export function headingStats(points: readonly EnrichedPoint[], from: number, to: number): {
  meanHeadingDeg: number | null;
  spread: number;
} {
  const headings: number[] = [];
  for (let i = Math.max(0, from); i <= Math.min(points.length - 1, to); i++) {
    const c = points[i].cog;
    if (c != null) headings.push(c);
  }
  return {
    meanHeadingDeg: circularMeanDeg(headings),
    spread: circularSpread(headings),
  };
}
