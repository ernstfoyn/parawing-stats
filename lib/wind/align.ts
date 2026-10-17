/**
 * Aligning wind observations with GPS timestamps.
 *
 * Rules:
 *  - A track point only gets wind data when an observation exists within `maxGapS`. Outside that
 *    window the wind is `null` and every downstream metric is `null` too. We never extrapolate a
 *    gust, and we never invent a direction.
 *  - Direction interpolation happens on the shortest arc (see `lerpAngle`) because directions are
 *    circular: the halfway point between 350° and 10° is 0°, not 180°.
 *  - Wind directions are meteorological: the value is the direction the wind comes FROM.
 */

import { DEG, angleDiffAbs, clamp, lerpAngle } from "../geo";
import { circularConcentration, circularMeanDeg } from "../geo";
import type {
  EnrichedPoint,
  ManualWind,
  TrackPoint,
  WindInterp,
  WindModel,
  WindQuality,
  WindSample,
} from "../types";

export interface AlignedWind {
  speedMps: number | null;
  gustMps: number | null;
  dirFromDeg: number | null;
  quality: WindQuality | null;
  interp: WindInterp;
}

/** Resolve the wind at an instant against a set of observations. */
export function windAt(
  t: number,
  samples: readonly WindSample[],
  maxGapS: number,
  interpolate: boolean,
): AlignedWind {
  const none: AlignedWind = {
    speedMps: null,
    gustMps: null,
    dirFromDeg: null,
    quality: null,
    interp: "none",
  };
  if (samples.length === 0) return none;

  const maxGapMs = maxGapS * 1000;
  // Samples arrive unsorted from providers more often than you would hope.
  const sorted = [...samples].sort((a, b) => a.t - b.t);

  if (t <= sorted[0].t) {
    if (sorted[0].t - t > maxGapMs) return none;
    return pick(sorted[0], t === sorted[0].t ? "exact" : "nearest");
  }
  const last = sorted[sorted.length - 1];
  if (t >= last.t) {
    if (t - last.t > maxGapMs) return none;
    return pick(last, t === last.t ? "exact" : "nearest");
  }

  let lo = sorted[0];
  let hi = last;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t >= t) {
      lo = sorted[i - 1];
      hi = sorted[i];
      break;
    }
  }

  const gapLo = t - lo.t;
  const gapHi = hi.t - t;
  if (lo.t === t) return pick(lo, "exact");
  if (hi.t === t) return pick(hi, "exact");

  if (!interpolate) {
    return gapLo <= gapHi ? pick(lo, "nearest") : pick(hi, "nearest");
  }

  // Interpolate only when both bracketing observations are themselves close enough in time.
  if (gapLo > maxGapMs || gapHi > maxGapMs) {
    return gapLo <= gapHi ? pick(lo, "nearest") : pick(hi, "nearest");
  }

  const span = hi.t - lo.t;
  const f = span > 0 ? gapLo / span : 0;

  const speed = blendOptional(lo.speedMps, hi.speedMps, f);
  const gust = blendOptional(lo.gustMps, hi.gustMps, f);
  const dir =
    lo.dirFromDeg != null && hi.dirFromDeg != null
      ? lerpAngle(lo.dirFromDeg, hi.dirFromDeg, f)
      : (lo.dirFromDeg ?? hi.dirFromDeg ?? null);

  return {
    speedMps: speed,
    gustMps: gust,
    dirFromDeg: dir,
    quality: lo.quality === hi.quality ? lo.quality : hi.quality,
    interp: "interpolated",
  };
}

function pick(s: WindSample, interp: WindInterp): AlignedWind {
  return {
    speedMps: s.speedMps,
    gustMps: s.gustMps,
    dirFromDeg: s.dirFromDeg,
    quality: s.quality,
    interp,
  };
}

function blendOptional(a: number | null, b: number | null, f: number): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * f;
}

/** True wind angle: the angular distance between where you are going and where the wind is from. */
export function trueWindAngle(cogDeg: number | null, windFromDeg: number | null): number | null {
  if (cogDeg == null || windFromDeg == null) return null;
  return angleDiffAbs(cogDeg, windFromDeg);
}

/**
 * Velocity made good, in m/s.
 *  - upwind: positive when making ground *towards* the wind source.
 *  - downwind: positive when making ground *away* from the wind source.
 */
export function vmg(speedMps: number | null, twaDeg: number | null, direction: "up" | "down"): number | null {
  if (speedMps == null || twaDeg == null) return null;
  const rad = twaDeg * DEG;
  return direction === "up" ? speedMps * Math.cos(rad) : -speedMps * Math.cos(rad);
}

/**
 * Attach wind, TWA and VMG to every point.
 *
 * @param points cleaned track
 * @param samples wind observations from the selected provider
 * @param model wind source configuration (tolerance, interpolation mode)
 * @param sessionRange used to build a constant "manual wind" sample set
 */
export function alignWind(
  points: readonly TrackPoint[],
  samples: readonly WindSample[],
  model: WindModel,
  sessionRange?: { start: number; end: number },
): EnrichedPoint[] {
  const effectiveSamples = resolveSamples(samples, model, sessionRange);
  return points.map((p) => {
    const w = windAt(p.t, effectiveSamples, model.maxGapS, model.interpolate);
    const twa = trueWindAngle(p.cog, w.dirFromDeg);
    return {
      ...p,
      windSpeedMps: w.speedMps,
      windGustMps: w.gustMps,
      windDirFromDeg: w.dirFromDeg,
      windQuality: w.quality,
      windInterp: w.interp,
      twa,
      vmgUpMps: vmg(p.speed, twa, "up"),
      vmgDownMps: vmg(p.speed, twa, "down"),
    };
  });
}

/**
 * Manual wind is a constant, so it is represented as two synthetic samples that bracket the
 * session. They are flagged `quality: "manual"` and are the only samples the app ever creates.
 */
export function manualSamples(manual: ManualWind, range: { start: number; end: number }): WindSample[] {
  const mk = (t: number): WindSample => ({
    t,
    speedMps: manual.speedMps,
    gustMps: manual.gustMps,
    dirFromDeg: manual.dirFromDeg,
    quality: "manual",
    providerId: "manual",
    stationId: null,
  });
  return [mk(range.start - 60_000), mk(range.end + 60_000)];
}

function resolveSamples(
  samples: readonly WindSample[],
  model: WindModel,
  range?: { start: number; end: number },
): readonly WindSample[] {
  if (model.kind === "manual" && model.manual) {
    return manualSamples(model.manual, range ?? { start: samples[0]?.t ?? Date.now(), end: samples[samples.length - 1]?.t ?? Date.now() });
  }
  return samples;
}

export interface WindSummary {
  /** time-weighted mean wind speed over the session, m/s */
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  maxGustMps: number | null;
  /** circular mean of the observed directions */
  meanDirFromDeg: number | null;
  /** 1 = every observation agrees on the direction, 0 = it swings through all points */
  directionConcentration: number;
  /** 0..1 fraction of track points with wind data inside the tolerance window */
  coverage: number;
  interpolatedFraction: number;
  nearestFraction: number;
  observationCount: number;
  firstT: number | null;
  lastT: number | null;
}

/** Summary of the wind used for the session (not of the raw station data). */
export function summariseAligned(points: readonly EnrichedPoint[]): WindSummary {
  let weightedSpeed = 0;
  let weight = 0;
  let withWind = 0;
  let interpolated = 0;
  let nearest = 0;
  const dirs: number[] = [];
  let maxSpeed: number | null = null;
  let maxGust: number | null = null;
  let firstT: number | null = null;
  let lastT: number | null = null;

  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].t - points[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const p = points[i];
    if (p.windSpeedMps != null || p.windDirFromDeg != null) {
      withWind++;
      if (p.windSpeedMps != null) {
        weightedSpeed += p.windSpeedMps * dt;
        weight += dt;
        if (maxSpeed == null || p.windSpeedMps > maxSpeed) maxSpeed = p.windSpeedMps;
      }
      if (p.windDirFromDeg != null) dirs.push(p.windDirFromDeg);
      if (p.windGustMps != null && (maxGust == null || p.windGustMps > maxGust)) {
        maxGust = p.windGustMps;
      }
      if (p.windInterp === "interpolated") interpolated++;
      if (p.windInterp === "nearest") nearest++;
      if (firstT == null) firstT = p.t;
      lastT = p.t;
    }
  }

  const considered = Math.max(1, points.length - 1);
  return {
    avgSpeedMps: weight > 0 ? weightedSpeed / weight : null,
    maxSpeedMps: maxSpeed,
    maxGustMps: maxGust,
    meanDirFromDeg: circularMeanDeg(dirs),
    directionConcentration: clamp(circularConcentration(dirs), 0, 1),
    coverage: withWind / considered,
    interpolatedFraction: withWind > 0 ? interpolated / withWind : 0,
    nearestFraction: withWind > 0 ? nearest / withWind : 0,
    observationCount: dirs.length,
    firstT,
    lastT,
  };
}
