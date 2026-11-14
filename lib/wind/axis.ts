/**
 * The wind axis, read from the rider's own courses.
 *
 * A beat is symmetric about the wind: sail close-hauled on port and on starboard and the two headings
 * sit at equal angles either side of the wind direction. Gybes are the same, mirrored. So the courses
 * a rider actually sailed carry an imprint of the wind direction that owes nothing to any weather
 * station, which is exactly what makes it worth having: an independent witness to the number
 * everything else in this app is measured against.
 *
 * Three things it cannot do, and none of them is hidden:
 *
 *  1. **It gives a line, not a direction.** The two ends are 180° apart, and nothing in the geometry
 *     distinguishes "the wind was from 194°" from "from 14°". Only a station can resolve which.
 *  2. **A pair of courses is symmetric about two perpendicular axes.** Headings at 190±45 are symmetric
 *     about 190 *and* about 100 — true for any pair. That is why the naive answer, the mean of the
 *     doubled headings, can land 90° out. The disambiguation is measured, not assumed: about the true
 *     axis the rider is spread over *both* sides, while about the perpendicular one both tacks fall on
 *     the same side. So the axis with the better side-balance wins, with no station consulted.
 *  3. **It is only as good as the symmetry.** A rider who favoured one tack has courses whose
 *     bisector leans toward it, so a lopsided split is reported and the estimate is withheld.
 *
 * The method: doubling every heading turns two clusters at `a ± d` into one cluster at `2a`, because
 * the `±2d` cancel. That gives the axis modulo 90, and `balanceAbout` chooses between the candidates.
 *
 * Built on time rather than samples: an interval counts for its real duration, so a track logged every
 * six seconds and one at 1 Hz describe the same session. No wind measurement is read anywhere in this
 * file.
 */

import { intervalAt } from "../metrics";
import type { EnrichedPoint } from "../types";

export interface WindAxisEstimate {
  /** the wind axis in degrees, in [0, 180), or null when the courses carry no usable symmetry */
  axisDeg: number | null;
  /**
   * How evenly the sailing time was split between the two sides of that axis: 1 is a dead-even split,
   * 0 means every interval fell on one side.
   */
  balance: number;
  /**
   * How far the first and second halves of the session disagree about the axis, in degrees.
   *
   * The guard against a coincidence. Courses with no real symmetry still produce *some* axis; they do
   * not produce the same one twice. If the two halves of a session disagree, the whole estimate is
   * noise and the UI says so instead of printing it.
   */
  stabilityDeg: number | null;
  /** measured seconds of sailing that went into it */
  usedS: number;
  /** how many headings contributed */
  used: number;
}

/** A split more lopsided than this means the axis is leaning, so it is not shown. */
export const AXIS_MIN_BALANCE = 0.4;
/** The two halves of a session must agree about the axis to within this. */
export const AXIS_MAX_UNSTABLE_DEG = 15;
/** And a handful of fixes cannot establish symmetry no matter how neat they look. */
export const AXIS_MIN_SECONDS = 120;

interface Heading {
  cog: number;
  dt: number;
}

const RAD = Math.PI / 180;

/** Unsigned angle between two bearings, 0..180. */
function between(from: number, to: number): number {
  return Math.abs(((to - from + 540) % 360) - 180);
}

/** The two perpendicular lines the doubled-heading mean is consistent with, folded into [0,180). */
function rawAxes(headings: readonly Heading[]): [number, number] | null {
  let x = 0;
  let y = 0;
  for (const h of headings) {
    x += Math.cos(2 * h.cog * RAD) * h.dt;
    y += Math.sin(2 * h.cog * RAD) * h.dt;
  }
  if (Math.hypot(x, y) < 1e-9) return null;
  const raw = (Math.atan2(y, x) / 2) * (180 / Math.PI);
  const a = ((raw % 180) + 180) % 180;
  return [a, (a + 90) % 180];
}

/** How evenly the sailing sits either side of an axis: 1 even, 0 all on one side. */
function balanceAbout(headings: readonly Heading[], axisDeg: number): number {
  let left = 0;
  let right = 0;
  for (const h of headings) {
    if (Math.sin((h.cog - axisDeg) * RAD) >= 0) left += h.dt;
    else right += h.dt;
  }
  const total = left + right;
  return total > 0 ? 1 - Math.abs(left - right) / total : 0;
}

/** Pick the candidate axis the rider is actually spread across, not the perpendicular that hides it. */
function chooseAxis(headings: readonly Heading[]): { axisDeg: number; balance: number } | null {
  const candidates = rawAxes(headings);
  if (!candidates) return null;
  let best = { axisDeg: candidates[0], balance: balanceAbout(headings, candidates[0]) };
  const second = { axisDeg: candidates[1], balance: balanceAbout(headings, candidates[1]) };
  if (second.balance > best.balance) best = second;
  return best;
}

/**
 * Estimate the wind axis from a session's courses.
 *
 * Only intervals that were actually sailed count: moving, measured, not across a gap. Idle time and
 * holes are excluded rather than treated as headings, because a parked rider's bearing is GPS noise.
 */
export function estimateWindAxis(points: readonly EnrichedPoint[]): WindAxisEstimate {
  const headings: Heading[] = [];
  for (let i = 1; i < points.length; i++) {
    const iv = intervalAt(points, i);
    if (!iv || iv.to.gap || !iv.to.moving) continue;
    const cog = iv.mid((p) => p.cog);
    if (cog == null) continue;
    const speed = iv.mid((p) => (p.gap ? null : p.speed));
    if (speed == null) continue;
    headings.push({ cog, dt: iv.dt });
  }

  const usedS = headings.reduce((a, h) => a + h.dt, 0);
  if (headings.length === 0 || usedS <= 0) {
    return { axisDeg: null, balance: 0, stabilityDeg: null, usedS: 0, used: 0 };
  }

  const chosen = chooseAxis(headings);
  if (!chosen) {
    return { axisDeg: null, balance: 0, stabilityDeg: null, usedS, used: headings.length };
  }

  // Split by sailing time, not by sample index, so a slow half cannot outvote a fast one.
  let half = 0;
  const halfway = usedS / 2;
  const first: Heading[] = [];
  const second: Heading[] = [];
  for (const h of headings) {
    if (half < halfway) first.push(h);
    else second.push(h);
    half += h.dt;
  }
  const a = chooseAxis(first);
  const b = chooseAxis(second);
  const stabilityDeg =
    a && b ? Math.min(between(a.axisDeg, b.axisDeg), 180 - between(a.axisDeg, b.axisDeg)) : null;

  return {
    axisDeg: chosen.axisDeg,
    balance: chosen.balance,
    stabilityDeg,
    usedS,
    used: headings.length,
  };
}

/**
 * How far a stated wind direction sits from the nearest end of the axis, in degrees.
 *
 * An axis is a line, so the wind came from either end and the nearer one is the one to judge. Anything
 * beyond about 15° means the station and the rider's own geometry describe different wind.
 */
export function axisDistance(a: WindAxisEstimate, dirFromDeg: number | null): number | null {
  if (a.axisDeg == null || dirFromDeg == null) return null;
  const other = (a.axisDeg + 180) % 360;
  return Math.min(between(dirFromDeg, a.axisDeg), between(dirFromDeg, other));
}

/** True when the estimate is solid enough to be worth showing at all. */
export function axisIsUsable(a: WindAxisEstimate): boolean {
  return (
    a.axisDeg != null &&
    a.balance >= AXIS_MIN_BALANCE &&
    a.usedS >= AXIS_MIN_SECONDS &&
    (a.stabilityDeg == null || a.stabilityDeg <= AXIS_MAX_UNSTABLE_DEG)
  );
}
