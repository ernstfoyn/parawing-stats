/**
 * Best-effort windows.
 *
 * "What was my best 1-minute speed?" is the question every GPS log answers badly: the obvious
 * implementation averages a fixed number of samples, which silently changes meaning when the
 * sampler rate or the signal quality changes mid-session.
 *
 * This module slides a window of *elapsed time* (1, 2 and 3 minutes) across the track and reports
 * the time-weighted mean inside it, so a window that happens to contain more samples is not
 * rewarded for it. Cumulative sums make the scan linear: the trapezoid value of an interval is a
 * property of that interval, so `(total[j] - total[i]) / (weight[j] - weight[i])` is exactly the
 * time-weighted mean over intervals `i+1..j`.
 *
 * A window must be both real and mostly covered:
 *  - it must fit entirely inside the track. A window the track cannot fill is not a 3-minute
 *    effort, so it does not exist rather than being reported as a shorter one.
 *  - and at least half of its nominal duration must carry a usable moving sample. A window
 *    swallowed by a signal gap is reported as nothing rather than as a slow best effort.
 */

import { intervalAt } from "./metrics";
import type { EnrichedPoint } from "./types";

export const DEFAULT_WINDOWS_MIN = [1, 2, 3] as const;

/** Below this share of nominal duration of usable moving data the window is discarded. */
const MIN_COVERAGE_FRACTION = 0.5;

export type EffortMetric = "speed" | "vmgUp" | "vmgDown";

export interface EffortWindow {
  metric: EffortMetric;
  minutes: number;
  /** time-weighted mean of the metric across the window, m/s */
  meanMps: number;
  /** epoch ms of the first and last point inside the window */
  startT: number;
  endT: number;
  startIdx: number;
  endIdx: number;
  /** seconds of usable moving samples inside the window */
  coveredS: number;
}

/** Cumulative trapezoid sums, indexed by the interval that *ends* at that point. */
interface Cumulative {
  weight: readonly number[];
  total: readonly number[];
}

function cumulative(
  points: readonly EnrichedPoint[],
  value: (p: EnrichedPoint) => number | null,
): Cumulative {
  const n = points.length;
  const weight = new Array<number>(n).fill(0);
  const total = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    weight[i] = weight[i - 1];
    total[i] = total[i - 1];
    const iv = intervalAt(points, i);
    if (!iv || !iv.to.moving) continue;
    const v = iv.mid(value);
    if (v == null) continue;
    weight[i] += iv.dt;
    total[i] += v * iv.dt;
  }
  return { weight, total };
}

interface Found {
  mean: number;
  startIdx: number;
  endIdx: number;
  coveredS: number;
}

/**
 * The highest time-weighted mean of `cum` over any window of `minutes`.
 *
 * Returns null when no window of that duration exists with enough real, moving data — the honest
 * answer for a session shorter than the window or one chopped up by gaps.
 */
function bestWindow(
  points: readonly EnrichedPoint[],
  minutes: number,
  cum: Cumulative,
): Found | null {
  const n = points.length;
  if (n < 2) return null;
  const spanMs = minutes * 60_000;
  const minCoverageS = (minutes * 60) * MIN_COVERAGE_FRACTION;
  const lastT = points[n - 1].t;

  let best: Found | null = null;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    // `j` only ever moves forward: the window end is monotonic in the window start.
    while (j + 1 < n && points[j + 1].t - points[i].t <= spanMs) j++;
    // The track must extend far enough past the start for the window to be full length.
    if (lastT - points[i].t < spanMs) continue;
    const weight = cum.weight[j] - cum.weight[i];
    if (weight < minCoverageS) continue;
    const total = cum.total[j] - cum.total[i];
    const mean = total / weight;
    if (best == null || mean > best.mean) {
      best = { mean, startIdx: i, endIdx: j, coveredS: weight };
    }
  }
  return best;
}

function toWindow(
  points: readonly EnrichedPoint[],
  metric: EffortMetric,
  minutes: number,
  found: Found,
): EffortWindow {
  return {
    metric,
    minutes,
    meanMps: found.mean,
    startT: points[found.startIdx].t,
    endT: points[found.endIdx].t,
    startIdx: found.startIdx,
    endIdx: found.endIdx,
    coveredS: found.coveredS,
  };
}

/**
 * Best window of each duration for speed, upwind VMG and downwind VMG.
 *
 * Ordered by duration and then by metric (speed, upwind, downwind) so the caller can lay the
 * results out as a stable grid. Metrics that have no data — VMG without wind — are simply absent.
 */
export function bestEfforts(
  points: readonly EnrichedPoint[],
  minutesList: readonly number[] = DEFAULT_WINDOWS_MIN,
): EffortWindow[] {
  if (points.length < 2) return [];

  const metrics: { metric: EffortMetric; cum: Cumulative }[] = [
    { metric: "speed", cum: cumulative(points, (p) => (p.gap ? null : p.speed)) },
    { metric: "vmgUp", cum: cumulative(points, (p) => p.vmgUpMps) },
    { metric: "vmgDown", cum: cumulative(points, (p) => p.vmgDownMps) },
  ];

  const out: EffortWindow[] = [];
  for (const minutes of minutesList) {
    for (const { metric, cum } of metrics) {
      const found = bestWindow(points, minutes, cum);
      if (found) out.push(toWindow(points, metric, minutes, found));
    }
  }
  return out;
}

/** Convenience lookup for a metric/duration pair out of a `bestEfforts` result. */
export function findEffort(
  windows: readonly EffortWindow[],
  metric: EffortMetric,
  minutes: number,
): EffortWindow | null {
  return windows.find((w) => w.metric === metric && w.minutes === minutes) ?? null;
}

/**
 * True when at least one VMG window exists. Without wind there are no VMG windows at all, and the
 * UI must say so rather than draw empty bars.
 */
export function hasVmgWindows(windows: readonly EffortWindow[]): boolean {
  return windows.some((w) => w.metric !== "speed");
}
