/**
 * Test helpers: tiny synthetic GPS tracks with known expected outcomes.
 *
 * Tracks are always built as raw samples and pushed through the *real* cleaning and wind
 * alignment code, so a test failure points at the pipeline and not at a test-only shortcut.
 */

import { cleanTrack, type CleanOptions } from "@/lib/clean";
import { destination } from "@/lib/geo";
import { alignWind } from "@/lib/wind/align";
import type {
  EnrichedPoint,
  RawActivityMeta,
  RawSample,
  WindModel,
} from "@/lib/types";

export interface Leg {
  headingDeg: number;
  speedMps: number;
  seconds: number;
  /** sampling interval in seconds, defaults to 1 */
  dtS?: number;
}

export const T0 = Date.UTC(2025, 5, 14, 12, 0, 0);

export interface SyntheticOptions {
  windFromDeg?: number | null;
  windSpeedMps?: number;
  start?: { lat: number; lon: number };
  t0?: number;
  noiseM?: number;
  /** include a device speed channel (default true) */
  deviceSpeed?: boolean;
  clean?: Partial<CleanOptions>;
  pauses?: { start: number; end: number }[];
}

/** Build raw samples for a sequence of straight legs. */
export function syntheticRaw(legs: Leg[], opts: SyntheticOptions = {}): RawSample[] {
  const start = opts.start ?? { lat: 58.7, lon: 5.5 };
  const t0 = opts.t0 ?? T0;
  const noise = opts.noiseM ?? 0;
  const samples: RawSample[] = [];
  let pos = { ...start };
  let t = t0;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (const leg of legs) {
    const dt = leg.dtS ?? 1;
    let elapsed = 0;
    while (elapsed < leg.seconds) {
      pos = destination(pos, leg.headingDeg, leg.speedMps * dt);
      const jitterLat = noise ? ((rand() - 0.5) * 2 * noise) / 111_320 : 0;
      const jitterLon =
        noise && pos.lon
          ? ((rand() - 0.5) * 2 * noise) / (111_320 * Math.cos((pos.lat * Math.PI) / 180))
          : 0;
      samples.push({
        t: Math.round(t),
        lat: pos.lat + jitterLat,
        lon: pos.lon + jitterLon,
        speed: opts.deviceSpeed === false ? null : leg.speedMps,
        ele: null,
        hr: null,
        cog: null,
        deviceDistance: null,
      });
      elapsed += dt;
      t += dt * 1000;
    }
  }
  return samples;
}

export function syntheticMeta(samples: RawSample[], opts: SyntheticOptions = {}): RawActivityMeta {
  return {
    format: "gpx",
    fileName: "synthetic.gpx",
    fileHash: "test",
    sport: "windsurfing",
    device: "synthetic",
    creator: null,
    timerStart: samples[0]?.t ?? null,
    timerEnd: samples[samples.length - 1]?.t ?? null,
    pauses: (opts.pauses ?? []).map((p) => ({ start: p.start, end: p.end })),
    timezoneOffsetMin: null,
    has: { speed: true, hr: false, ele: false, cog: false, distance: false },
    warnings: [],
  };
}

export function manualWindModel(fromDeg: number, speedMps = 8, maxGapS = 5400): WindModel {
  return {
    kind: "manual",
    station: null,
    manual: { speedMps, dirFromDeg: fromDeg, gustMps: null },
    maxGapS,
    interpolate: true,
  };
}

/** Raw → cleaned → wind-aligned, ready for classification. */
export function syntheticEnriched(
  legs: Leg[],
  opts: SyntheticOptions = {},
): EnrichedPoint[] {
  const samples = syntheticRaw(legs, opts);
  const meta = syntheticMeta(samples, opts);
  const { points } = cleanTrack(samples, meta, opts.clean ?? {});
  if (opts.windFromDeg == null) {
    const model = manualWindModel(0);
    return alignWind(points, [], model, {
      start: points[0].t,
      end: points[points.length - 1].t,
    }).map((p) => ({ ...p, windSpeedMps: null, windDirFromDeg: null, twa: null, vmgUpMps: null, vmgDownMps: null }));
  }
  const model = manualWindModel(opts.windFromDeg, opts.windSpeedMps ?? 8);
  return alignWind(points, [], model, {
    start: points[0].t,
    end: points[points.length - 1].t,
  });
}
