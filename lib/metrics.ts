/**
 * Session metrics.
 *
 * Everything is computed from the timestamps and the actual GPS displacement between samples.
 * No function here assumes a fixed sampling interval: a watch that drops to 0.5 Hz mid-session
 * must not change the reported averages, and the time-weighted helpers below guarantee that.
 */

import { angleDelta, circularMeanDeg, circularSpread, percentile } from "./geo";
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
 * Speed smoothed with a rolling mean whose window is a *duration* (not a sample count), so it works
 * at any sampling rate. Null wherever the point is not usable, so a caller can plot it directly.
 */
export function smoothedSpeeds(points: readonly EnrichedPoint[], windowS = 3): (number | null)[] {
  const samples: { t: number; speed: number }[] = [];
  for (const p of points) {
    if (p.gap || !p.moving || p.speed == null) continue;
    samples.push({ t: p.t, speed: p.speed });
  }
  if (samples.length === 0) return points.map(() => null);
  const half = (windowS * 1000) / 2;

  // Walk outwards from each sample while inside the half window; samples are time ordered.
  const smoothed: number[] = new Array(samples.length).fill(0);
  for (let i = 0; i < samples.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i; j >= 0 && samples[i].t - samples[j].t <= half; j--) {
      sum += samples[j].speed;
      n++;
    }
    for (let j = i + 1; j < samples.length && samples[j].t - samples[i].t <= half; j++) {
      sum += samples[j].speed;
      n++;
    }
    smoothed[i] = sum / n;
  }

  // Hand the values back on the original index grid so a caller can zip them with `points`.
  const byT = new Map(samples.map((s, i) => [s.t, smoothed[i]]));
  return points.map((p) => {
    if (p.gap || !p.moving || p.speed == null) return null;
    return byT.get(p.t) ?? null;
  });
}

/**
 * Maximum speed, using the same rolling mean as `smoothedSpeeds`. A single noisy sample cannot
 * become the session maximum.
 */
export function smoothedMaxSpeed(points: readonly EnrichedPoint[], windowS = 3): number | null {
  const smoothed = smoothedSpeeds(points, windowS).filter((v): v is number => v != null);
  return smoothed.length > 0 ? Math.max(...smoothed) : null;
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

/** One band of a time-at-speed breakdown: how long, and how far, at this speed. */
export interface SpeedBand extends HistogramBucket {
  /** metres covered while in this band */
  distanceM: number;
  /** this band's share of the total time in the breakdown, 0..1 */
  share: number;
}

/** A run of samples to include in a breakdown: `startIdx`..`endIdx`, both inclusive. */
export interface IndexRange {
  startIdx: number;
  endIdx: number;
}

/**
 * Time and distance spent at each speed, restricted to a set of index ranges.
 *
 * This is what answers "how long did I ride at which speed, while going downwind": the ranges are
 * the downwind runs, and the walk must never bridge the gap between two of them — doing so would
 * invent a downwind interval that never happened. Interval handling (trapezoidal values, moving
 * filter, gaps dropped) matches the rest of the metrics, so the bands always sum to the same total
 * the run table reports.
 */
export function speedBandsInRanges(
  points: readonly EnrichedPoint[],
  ranges: readonly IndexRange[],
  bandWidthMps = 1,
  maxMps = 20,
): SpeedBand[] {
  const width = bandWidthMps > 0 ? bandWidthMps : 1;
  const count = Math.max(1, Math.ceil(maxMps / width));
  const bands: SpeedBand[] = Array.from({ length: count }, (_, i) => ({
    fromMps: i * width,
    toMps: (i + 1) * width,
    timeS: 0,
    distanceM: 0,
    share: 0,
  }));

  let totalTimeS = 0;
  for (const range of ranges) {
    // An interval is the pair (i-1, i), so the lowest index that can contribute is 1.
    const from = Math.max(1, range.startIdx);
    const to = Math.min(points.length - 1, range.endIdx);
    for (let i = from; i <= to; i++) {
      const iv = intervalAt(points, i);
      if (!iv || !iv.to.moving) continue;
      const v = iv.mid((p) => (p.gap ? null : p.speed));
      if (v == null) continue;
      const idx = Math.min(count - 1, Math.max(0, Math.floor(v / width)));
      bands[idx].timeS += iv.dt;
      bands[idx].distanceM += iv.dd;
      totalTimeS += iv.dt;
    }
  }
  if (totalTimeS > 0) for (const b of bands) b.share = b.timeS / totalTimeS;
  return bands;
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

/* ------------------------------------------------------- one stretch in detail */

/** One slice of a single stretch of track, for the "zoom in on this run" view. */
export interface StretchPart {
  /** 1-based */
  n: number;
  startIdx: number;
  endIdx: number;
  startT: number;
  endT: number;
  durationS: number;
  distanceM: number;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  avgTwaDeg: number | null;
  /**
   * How much the course changed across this slice, in degrees, signed with `angleDelta`: positive
   * means the rider turned to starboard. This is the honest answer to "how did I carve it" — the
   * mean course as the rider entered the slice against the mean course as they left it, taken the
   * short way round the compass. Null when there is no course to compare, which the UI prints as
   * "—": a stretch the watch did not log cannot be reported as having turned zero degrees.
   */
  turnDeg: number | null;
}

/**
 * Mean course as the rider *enters* or *leaves* a slice, read from a couple of fixes straddling
 * that boundary rather than from inside the slice.
 *
 * The distinction matters on a track that is logged sparsely. Taking the heading from the slice's
 * own first and last few fixes works at 1 Hz, but a real GPX logged every ~7 s gave a 52 s run only
 * 8 fixes — so a four-slice split asked each slice to define two headings out of two fixes, the
 * entry and exit windows landed on the same samples, and every slice reported a turn of exactly
 * 0°. A run that visibly doubles back on the map was reported as dead straight, which is a
 * fabricated measurement rather than a missing one.
 *
 * Straddling the boundary fixes that: the entry window ends at the slice's first fix and the exit
 * window starts at its last, so the two are always different samples and a short slice still
 * measures a real course change. The windows are clamped to the run's own range, so nothing leaks in
 * from the track either side of it.
 */
function edgeHeading(
  points: readonly EnrichedPoint[],
  runStart: number,
  runEnd: number,
  boundary: number,
  which: "first" | "last",
  take = 2,
): number | null {
  const headings: number[] = [];
  if (which === "first") {
    // The last `take` fixes ending at the slice's first fix.
    for (let i = boundary; i >= runStart && headings.length < take; i--) {
      const c = points[i].cog;
      if (c != null) headings.push(c);
    }
  } else {
    // The first `take` fixes starting at the slice's last fix.
    for (let i = boundary; i <= runEnd && headings.length < take; i++) {
      const c = points[i].cog;
      if (c != null) headings.push(c);
    }
  }
  return circularMeanDeg(headings);
}

/**
 * Split one stretch of track into `parts` equal-duration slices.
 *
 * Equal *duration*, not equal distance and not equal sample count: a run that slowed to a crawl in
 * the middle should not gain a slice just because the watch kept logging while the rider was parked
 * on a swell.
 */
export function stretchParts(
  points: readonly EnrichedPoint[],
  startIdx: number,
  endIdx: number,
  parts: number,
): StretchPart[] {
  const from = Math.max(0, startIdx);
  const to = Math.min(points.length - 1, endIdx);
  if (to <= from || parts < 1) return [];
  const t0 = points[from].t;
  const span = points[to].t - t0;
  if (span <= 0) return [];

  // Boundary indices: the first sample at or after each equal-duration mark.
  const bounds: number[] = [from];
  for (let k = 1; k < parts; k++) {
    const target = t0 + (span * k) / parts;
    let i = bounds[k - 1];
    while (i < to && points[i].t < target) i++;
    bounds.push(Math.max(i, bounds[k - 1]));
  }
  bounds.push(to);

  const out: StretchPart[] = [];
  for (let k = 0; k < parts; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    if (b <= a) continue;

    let timeS = 0;
    let distanceM = 0;
    let speedWeighted = 0;
    let speedWeight = 0;
    let maxSpeedMps: number | null = null;
    const twas: number[] = [];

    for (let i = a + 1; i <= b; i++) {
      const iv = intervalAt(points, i);
      if (!iv) continue;
      timeS += iv.dt;
      distanceM += iv.dd;
      const v = iv.mid((p) => (p.gap ? null : p.speed));
      if (v != null) {
        speedWeighted += v * iv.dt;
        speedWeight += iv.dt;
      }
      const twa = iv.mid((p) => p.twa);
      if (twa != null) twas.push(twa);
    }
    for (let i = a; i <= b; i++) {
      const s = points[i].speed;
      if (s == null) continue;
      maxSpeedMps = maxSpeedMps == null ? s : Math.max(maxSpeedMps, s);
    }

    const head = edgeHeading(points, from, to, a, "first");
    const tail = edgeHeading(points, from, to, b, "last");

    out.push({
      n: out.length + 1,
      startIdx: a,
      endIdx: b,
      startT: points[a].t,
      endT: points[b].t,
      durationS: timeS,
      distanceM,
      avgSpeedMps: speedWeight > 0 ? speedWeighted / speedWeight : null,
      maxSpeedMps,
      avgTwaDeg: circularMeanDeg(twas),
      turnDeg: head != null && tail != null ? angleDelta(tail, head) : null,
    });
  }
  return out;
}
