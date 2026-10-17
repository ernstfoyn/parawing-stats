/**
 * Demo activity.
 *
 * A deterministic, *clearly synthetic* parawing session used to exercise the whole UI before a
 * real file is imported. It is not a recording and is never presented as one: every session built
 * here has `demo: true`, the UI badges it, and the wind that comes with it is the manual-wind
 * source so nothing pretends to be a weather observation.
 *
 * The track is deliberately messy in the same ways a real watch file is: a duplicate timestamp, a
 * GPS jump, a pause with the timer stopped, a sampling hole, and 1 Hz vs 2 Hz stretches.
 */

import { destination, normalize360 } from "./geo";
import { cleanTrack } from "./clean";
import { alignWind, manualSamples } from "./wind/align";
import type { RawActivityMeta, RawSample, TrackPoint, WindModel, WindSample } from "./types";
import type { CleanupReport } from "./types";
import { EMPTY_EQUIPMENT } from "./types";

export const DEMO_LOCATION = { lat: 58.7345, lon: 5.5215 }; // Jæren coast, Norway
export const DEMO_WIND_FROM_DEG = 300; // wind blows FROM the WNW
export const DEMO_WIND_SPEED_MPS = 9;
export const DEMO_WIND_GUST_MPS = 12.5;
export const DEMO_START_TIME = Date.UTC(2025, 5, 14, 12, 4, 0); // 14 June 2025, 14:04 local (UTC+2)

interface Leg {
  headingDeg: number;
  speedMps: number;
  seconds: number;
  /** how much the rider weaves: heading oscillation amplitude in degrees */
  weaveDeg?: number;
  weavePeriodS?: number;
  /** true for the wave-riding runs, which vary more and carry more speed */
  surf?: boolean;
}

/** mulberry32: tiny deterministic PRNG so the demo is identical on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sample. */
function normal(random: () => number): number {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const LEGS: Leg[] = [
  { headingDeg: 150, speedMps: 1.3, seconds: 170 }, // pumping out through the shore break
  { headingDeg: 255, speedMps: 6.3, seconds: 350, weaveDeg: 6, weavePeriodS: 40 }, // port tack upwind
  { headingDeg: 345, speedMps: 6.1, seconds: 350, weaveDeg: 6, weavePeriodS: 40 }, // starboard tack upwind
  { headingDeg: 135, speedMps: 8.1, seconds: 235, weaveDeg: 14, weavePeriodS: 25 }, // powered downwind
  { headingDeg: 118, speedMps: 11.4, seconds: 155, weaveDeg: 26, weavePeriodS: 18, surf: true }, // free downwind
  { headingDeg: 255, speedMps: 6.4, seconds: 330, weaveDeg: 7, weavePeriodS: 44 },
  { headingDeg: 345, speedMps: 6.2, seconds: 330, weaveDeg: 7, weavePeriodS: 44 },
  { headingDeg: 140, speedMps: 8.3, seconds: 200, weaveDeg: 15, weavePeriodS: 24 },
  { headingDeg: 112, speedMps: 12.1, seconds: 185, weaveDeg: 30, weavePeriodS: 16, surf: true },
  { headingDeg: 255, speedMps: 6.5, seconds: 300, weaveDeg: 7, weavePeriodS: 44 },
  { headingDeg: 136, speedMps: 8.0, seconds: 215, weaveDeg: 15, weavePeriodS: 24 },
  { headingDeg: 200, speedMps: 1.6, seconds: 130 }, // drifting back to the beach
];

/**
 * Build the raw (pre-cleaning) sample list, including the deliberate artefacts described above.
 */
export function generateDemoRaw(): { samples: RawSample[]; meta: RawActivityMeta } {
  const random = rng(20250614);
  const samples: RawSample[] = [];
  const positions: { t: number; lat: number; lon: number; speed: number; hr: number }[] = [];

  let pos = { ...DEMO_LOCATION };
  let t = DEMO_START_TIME;
  let prevHeading = LEGS[0].headingDeg;
  let prevSpeed = 0.8;
  let hr = 118;

  for (let li = 0; li < LEGS.length; li++) {
    const leg = LEGS[li];
    const target = leg.speedMps;
    const transitionS = li === 0 ? 0 : leg.surf ? 6 : 10;
    let elapsed = 0;
    let weavePhase = random() * Math.PI * 2;

    while (elapsed < leg.seconds) {
      // Sampling rate: 2 Hz inside the two free-surf runs, 1 Hz everywhere else.
      const dt = leg.surf ? 0.5 : 1;
      elapsed += dt;

      // Heading: ramp away from the previous leg (a tack or a gybe takes a few seconds),
      // plus the weave that makes the rider's course wander.
      const ramp = transitionS > 0 ? Math.min(1, elapsed / transitionS) : 1;
      const eased = ramp * ramp * (3 - 2 * ramp);
      const baseHeading = interpolateHeading(prevHeading, leg.headingDeg, eased);
      weavePhase += (2 * Math.PI * dt) / (leg.weavePeriodS ?? 1000);
      const weave = (leg.weaveDeg ?? 0) * Math.sin(weavePhase) * (0.4 + 0.6 * eased);

      // Speed: accelerate from the previous leg, then oscillate around the target. Surf runs get
      // bigger surges (catching and losing swell).
      const speedRamp = Math.min(1, ramp);
      const targetSpeed = prevSpeed + (target - prevSpeed) * speedRamp;
      const surge = leg.surf
        ? Math.sin(weavePhase * 0.5) * 1.6 + normal(random) * 0.5
        : normal(random) * 0.18;
      const speed = Math.max(0.2, targetSpeed + surge * speedRamp);
      const heading = normalize360(baseHeading + weave);

      const dist = speed * dt;
      pos = destination(pos, heading, dist);

      hr += (leg.surf ? 0.25 : -0.15) * dt + normal(random) * 0.8;
      hr = Math.max(96, Math.min(178, hr));

      // ~1.5 m of GPS jitter, independent in each direction.
      const jitterM = 1.5;
      const jitterLat = (normal(random) * jitterM) / 111_320;
      const jitterLon =
        (normal(random) * jitterM) / (111_320 * Math.cos((pos.lat * Math.PI) / 180));

      t += dt * 1000;
      positions.push({
        t: Math.round(t),
        lat: pos.lat + jitterLat,
        lon: pos.lon + jitterLon,
        speed,
        hr,
      });
    }

    prevHeading = leg.headingDeg;
    prevSpeed = leg.speedMps;

    // A paused timer after the second leg: the rider is standing on the beach adjusting kit.
    // No samples are produced, which is exactly how a Garmin pause looks in the file.
    if (li === 1) {
      t += 48_000;
    }
  }

  // ------------------------------------------------------------------ artefacts
  for (const p of positions) {
    samples.push({
      t: p.t,
      lat: p.lat,
      lon: p.lon,
      speed: p.speed,
      ele: 0.4 + Math.sin(p.t / 90_000) * 0.3,
      hr: Math.round(p.hr),
      cog: null, // Garmin does not record course; the app derives it from position
      deviceDistance: null,
    });
  }

  // 1) A duplicated timestamp (two fixes in the same second).
  const dupIdx = Math.floor(samples.length * 0.3);
  samples.splice(dupIdx, 0, { ...samples[dupIdx], speed: samples[dupIdx].speed });

  // 2) One wild GPS fix: ~260 m to the west for a single sample.
  const jumpIdx = Math.floor(samples.length * 0.62);
  samples[jumpIdx] = {
    ...samples[jumpIdx],
    lon: samples[jumpIdx].lon - 0.0046,
  };

  // 3) A ~14 s sampling hole mid-session, as if the watch lost the satellite lock.
  const holeIdx = Math.floor(samples.length * 0.45);
  for (let i = 0; i < 14; i++) samples.splice(holeIdx, 1);

  // 4) A couple of heart-rate dropouts.
  samples[Math.floor(samples.length * 0.2)].hr = null;
  samples[Math.floor(samples.length * 0.75)].hr = null;

  // The paused interval is where the generator inserted the 48 s hole above.
  const pauseStart = DEMO_START_TIME + LEGS.slice(0, 2).reduce((a, l) => a + l.seconds, 0) * 1000;

  const meta: RawActivityMeta = {
    format: "fit",
    fileName: "demo-parawing-jaeren.fit",
    fileHash: "demo",
    sport: "windsurfing",
    device: "Garmin (synthetic demo)",
    creator: "synthetic",
    timerStart: samples[0].t,
    timerEnd: samples[samples.length - 1].t,
    pauses: [{ start: pauseStart, end: pauseStart + 48_000 }],
    timezoneOffsetMin: 120, // the demo is a Norwegian summer session, UTC+2
    has: { speed: true, hr: true, ele: true, cog: false, distance: false },
    warnings: [
      "Synthetic demo activity generated by Foil Analyzer. Not a real recording.",
      "The demo wind is the manual wind source, not a weather observation.",
    ],
  };
  return { samples, meta };
}

function interpolateHeading(from: number, to: number, f: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return normalize360(from + delta * f);
}

export interface DemoActivity {
  points: TrackPoint[];
  meta: RawActivityMeta;
  report: CleanupReport;
  windSamples: WindSample[];
  windModel: WindModel;
}

/**
 * Cleaned demo track plus the manual wind that goes with it. The track is run through the real
 * cleaning pipeline, so the artefacts above are visible in the import report.
 */
export function buildDemoActivity(): DemoActivity {
  const { samples, meta } = generateDemoRaw();
  const { points, report } = cleanTrack(samples, meta);
  report.notes.unshift(
    "This is a synthetic demo activity: the GPS track and the wind were generated by Foil Analyzer.",
  );

  const windModel: WindModel = {
    kind: "manual",
    station: null,
    manual: {
      speedMps: DEMO_WIND_SPEED_MPS,
      dirFromDeg: DEMO_WIND_FROM_DEG,
      gustMps: DEMO_WIND_GUST_MPS,
    },
    maxGapS: 5400,
    interpolate: true,
  };

  const windSamples = manualSamples(windModel.manual!, {
    start: points[0].t,
    end: points[points.length - 1].t,
  });

  return { points, meta, report, windSamples, windModel };
}

/** Demo equipment, matching the kit the author actually rides. */
export const DEMO_EQUIPMENT = {
  ...EMPTY_EQUIPMENT,
  id: "equipment-demo",
  name: "Gong Plus V2 4 m² / Veloce M",
  parawingBrand: "Gong",
  parawingModel: "Plus V2",
  parawingSizeM2: 4,
  foilModel: "Gong Veloce M V3",
  foilSize: "M",
  stabilizer: "Gong Veloce M stabilizer",
  boardModel: "Appletree Skipper Midlength",
  boardVolumeL: 74,
  notes: "Demo profile.",
};

/** Wind over the demo track, aligned, for a sanity check in tests and the UI preview. */
export function demoEnriched(): ReturnType<typeof alignWind> {
  const demo = buildDemoActivity();
  return alignWind(demo.points, demo.windSamples, demo.windModel, {
    start: demo.points[0].t,
    end: demo.points[demo.points.length - 1].t,
  });
}
