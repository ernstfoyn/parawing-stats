/**
 * Track cleaning.
 *
 * GPS files from watches are messy: duplicate timestamps, positions that jump hundreds of metres
 * for one sample, pauses, gaps and outliers. This module turns `RawSample[]` into a `TrackPoint[]`
 * that the rest of the app can trust, and records exactly what it removed so the UI can be honest
 * about data quality.
 *
 * Two rules govern everything here:
 *  1. Never invent a measurement. Nothing is interpolated into existence; unusable samples are
 *     dropped and counted instead.
 *  2. All timing comes from the file's own timestamps, never from an assumed sample interval.
 */

import { bearingDeg, haversineM, isPlausiblePosition, median } from "./geo";
import type { CleanupReport, RawActivityMeta, RawSample, TrackPoint } from "./types";

export interface CleanOptions {
  /** dt above this is a pause or lost signal, seconds */
  gapThresholdS: number;
  /** absolute speed ceiling; faster than this is a GPS artefact, m/s (25 m/s ≈ 49 kn) */
  maxSpeedMps: number;
  /** device speeds above median * this factor are rejected... */
  spikeFactor: number;
  /** ...but only if they also exceed the median by this many m/s */
  spikeExcessMps: number;
  /** speed above which an interval counts as moving, m/s */
  movingThresholdMps: number;
  /** window used to derive course over ground when the file has none, seconds */
  courseWindowS: number;
  /** drop samples covered by a device timer pause */
  dropPaused: boolean;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  gapThresholdS: 15,
  maxSpeedMps: 25,
  spikeFactor: 3,
  spikeExcessMps: 6,
  movingThresholdMps: 0.5,
  courseWindowS: 3,
  dropPaused: true,
};

export interface CleanResult {
  points: TrackPoint[];
  report: CleanupReport;
}

/** Sorts a copy of the samples by timestamp, reporting how many were out of order. */
function sortSamples(samples: readonly RawSample[]): { sorted: RawSample[]; outOfOrder: number } {
  let outOfOrder = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t < samples[i - 1].t) outOfOrder++;
  }
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  return { sorted, outOfOrder };
}

function isPaused(t: number, meta: RawActivityMeta | null): boolean {
  if (!meta?.pauses?.length) return false;
  for (const p of meta.pauses) {
    // A pause that never stopped (end === null) only covers its own instant; treat an open pause
    // as covering from `start` up to the first sample after the timer restarted.
    if (p.end != null && t > p.start && t < p.end) return true;
  }
  return false;
}

/**
 * True when the interval between two kept points is exactly a device pause. That interval is a
 * real stop (the rider was on the beach or holding the wing), so it must not count as moving time
 * even though the rider's device speed may still read something at the edges.
 */
function pauseCovers(prevT: number, curT: number, meta: RawActivityMeta | null): boolean {
  if (!meta?.pauses?.length) return false;
  return meta.pauses.some(
    (p) => p.end != null && p.start >= prevT && p.end <= curT && p.end > p.start,
  );
}

/**
 * Clean a raw track.
 *
 * @param samples raw samples straight from the importer
 * @param meta metadata from the importer (pauses, channel availability)
 */
export function cleanTrack(
  samples: readonly RawSample[],
  meta: RawActivityMeta | null = null,
  options: Partial<CleanOptions> = {},
): CleanResult {
  const opts = { ...DEFAULT_CLEAN_OPTIONS, ...options };
  const notes: string[] = [];

  const { sorted, outOfOrder } = sortSamples(samples);
  if (outOfOrder > 0) {
    notes.push(`${outOfOrder} sample(s) were out of chronological order and have been re-sorted.`);
  }

  const kept: Array<{
    sample: RawSample;
    deviceSpeed: number | null;
    deviceCog: number | null;
    dd: number;
    dt: number;
    dist: number;
    moving: boolean;
    gap: boolean;
    /** the interval before this point is a device pause (a real stop) */
    paused: boolean;
  }> = [];

  let droppedInvalidPosition = 0;
  let droppedDuplicateTimestamp = 0;
  let droppedSpeedSpike = 0;
  let droppedPaused = 0;
  let impossibleDeviceSpeeds = 0;
  let gaps = 0;
  let longestGapS = 0;
  let gapTotalS = 0;

  const impliedSpeeds: number[] = [];

  for (const s of sorted) {
    if (!isPlausiblePosition(s.lat, s.lon)) {
      droppedInvalidPosition++;
      continue;
    }
    if (!Number.isFinite(s.t)) {
      droppedInvalidPosition++;
      continue;
    }
    if (opts.dropPaused && isPaused(s.t, meta)) {
      droppedPaused++;
      continue;
    }

    const prev = kept[kept.length - 1];
    if (prev) {
      if (s.t === prev.sample.t) {
        droppedDuplicateTimestamp++;
        continue;
      }
      const dd = haversineM(prev.sample, s);
      const dt = (s.t - prev.sample.t) / 1000;
      if (dt <= 0) {
        droppedDuplicateTimestamp++;
        continue;
      }
      const implied = dd / dt;
      impliedSpeeds.push(implied);
      if (implied > opts.maxSpeedMps) {
        // Either a GPS jump or a teleporting fix. Compare it with the track's recent typical speed
        // so that one wild sample cannot drag the reference with it.
        droppedSpeedSpike++;
        continue;
      }
      // A device speed that is impossible is dropped, but the position is still usable.
      if (s.speed != null && saneDeviceSpeed(s.speed, opts) == null) impossibleDeviceSpeeds++;
      const deviceSpeed = saneDeviceSpeed(s.speed, opts);
      kept.push({
        sample: s,
        deviceSpeed,
        deviceCog: s.cog,
        dd,
        dt,
        dist: 0,
        moving: false,
        gap: false,
        paused: pauseCovers(prev.sample.t, s.t, meta),
      });
      continue;
    }

    // First kept point.
    if (s.speed != null && saneDeviceSpeed(s.speed, opts) == null) impossibleDeviceSpeeds++;
    kept.push({
      sample: s,
      deviceSpeed: saneDeviceSpeed(s.speed, opts),
      deviceCog: s.cog,
      dd: 0,
      dt: 0,
      dist: 0,
      moving: false,
      gap: false,
      paused: false,
    });
  }

  if (kept.length < 2) {
    return {
      points: [],
      report: {
        totalRaw: samples.length,
        kept: kept.length,
        droppedInvalidPosition,
        droppedDuplicateTimestamp,
        droppedSpeedSpike,
        droppedOutOfOrder: outOfOrder,
        droppedGpsJump: 0,
        droppedPaused,
        gaps: 0,
        gapTotalS: 0,
        longestGapS: 0,
        timezoneOffsetMin: meta?.timezoneOffsetMin ?? null,
        notes: [...notes, "The file contains fewer than two usable position fixes."],
      },
    };
  }

  // ---------------------------------------------------------------- outlier pass
  // Reject device speeds that are wild compared with the rest of the track. This keeps a single
  // corrupt Doppler sample from setting the session's maximum speed.
  const typicalSpeed = median(impliedSpeeds.filter((v) => v > opts.movingThresholdMps));
  let rejectedDeviceSpeeds = 0;
  if (typicalSpeed != null && typicalSpeed > 0) {
    for (const k of kept) {
      if (k.deviceSpeed == null) continue;
      if (
        k.deviceSpeed > typicalSpeed * opts.spikeFactor &&
        k.deviceSpeed > typicalSpeed + opts.spikeExcessMps
      ) {
        k.deviceSpeed = null;
        rejectedDeviceSpeeds++;
      }
    }
  }
  if (rejectedDeviceSpeeds > 0) {
    notes.push(
      `${rejectedDeviceSpeeds} device speed sample(s) were inconsistent with the track and were replaced by speeds derived from position.`,
    );
  }
  if (impossibleDeviceSpeeds > 0) {
    notes.push(
      `${impossibleDeviceSpeeds} device speed sample(s) were outside the physically possible range and were discarded; speed at those points is derived from position instead.`,
    );
  }

  // ---------------------------------------------------------------- course over ground
  // Derive COG from the actual displacement when the device did not record one, using a window of
  // a few seconds so single-sample GPS noise does not swing the heading.
  const derivedCourse = deriveCourse(
    kept.map((k) => k.sample),
    opts.courseWindowS,
  );

  // ---------------------------------------------------------------- assemble
  const points: TrackPoint[] = [];
  let dist = 0;
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const isGap = i > 0 && k.dt > opts.gapThresholdS;
    if (isGap) {
      gaps++;
      gapTotalS += k.dt;
      longestGapS = Math.max(longestGapS, k.dt);
    }
    dist += k.dd;

    const derived = k.dt > 0 ? k.dd / k.dt : null;
    // Over a gap we do not know the path, so a derived speed would be a straight-line guess.
    const speed = k.deviceSpeed ?? (isGap ? null : derived);
    const moving = k.paused
      ? false
      : isGap
        ? k.deviceSpeed != null && k.deviceSpeed >= opts.movingThresholdMps
        : (speed ?? 0) >= opts.movingThresholdMps;

    points.push({
      t: k.sample.t,
      lat: k.sample.lat,
      lon: k.sample.lon,
      ele: k.sample.ele,
      hr: k.sample.hr,
      speed,
      speedFromDevice: k.deviceSpeed != null,
      cog: k.deviceCog != null ? k.deviceCog : derivedCourse[i],
      dist,
      dt: k.dt,
      dd: k.dd,
      moving,
      gap: isGap,
    });
  }

  if (gaps > 0) {
    notes.push(
      `${gaps} gap(s) longer than ${opts.gapThresholdS}s (longest ${Math.round(longestGapS)}s). Time inside gaps is excluded from moving time, and speeds inside them are not derived from position.`,
    );
  }
  if (droppedSpeedSpike > 0) {
    notes.push(
      `${droppedSpeedSpike} position fix(es) implied an impossible speed (>${opts.maxSpeedMps} m/s) and were removed.`,
    );
  }
  if (droppedDuplicateTimestamp > 0) {
    notes.push(`${droppedDuplicateTimestamp} duplicate or non-advancing timestamp(s) were removed.`);
  }
  if (droppedInvalidPosition > 0) {
    notes.push(`${droppedInvalidPosition} invalid position fix(es) were removed.`);
  }
  if (droppedPaused > 0) {
    notes.push(`${droppedPaused} sample(s) inside a paused timer interval were removed.`);
  }
  if (!meta?.has.speed) {
    notes.push("The file has no device speed channel, so speed is derived from GPS displacement.");
  }
  if (!meta?.has.cog) {
    notes.push("The file has no course channel, so heading is derived from GPS displacement.");
  }

  const report: CleanupReport = {
    totalRaw: samples.length,
    kept: points.length,
    droppedInvalidPosition,
    droppedDuplicateTimestamp,
    droppedSpeedSpike,
    droppedOutOfOrder: outOfOrder,
    droppedGpsJump: droppedSpeedSpike,
    droppedPaused,
    gaps,
    longestGapS,
    gapTotalS,
    timezoneOffsetMin: meta?.timezoneOffsetMin ?? null,
    notes,
  };

  return { points, report };
}

/** Rejects impossible device speeds outright; the caller does the relative-outlier pass later. */
function saneDeviceSpeed(speed: number | null, opts: CleanOptions): number | null {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return null;
  if (speed > opts.maxSpeedMps) return null;
  return speed;
}

/**
 * Course over ground from displacement, averaged over a window of `windowS` seconds on each side
 * of the sample. The window adapts to the actual sampling rate instead of assuming a fixed one.
 */
export function deriveCourse(samples: readonly RawSample[], windowS: number): (number | null)[] {
  const n = samples.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let back = i;
    let fwd = i;
    let backT = 0;
    let fwdT = 0;
    while (back > 0 && backT < windowS) {
      backT += (samples[back].t - samples[back - 1].t) / 1000;
      back--;
    }
    while (fwd < n - 1 && fwdT < windowS) {
      fwdT += (samples[fwd + 1].t - samples[fwd].t) / 1000;
      fwd++;
    }
    if (fwd === back) {
      out[i] = null;
      continue;
    }
    out[i] = bearingDeg(samples[back], samples[fwd]);
  }
  return out;
}


