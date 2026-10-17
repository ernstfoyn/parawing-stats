import { describe, expect, it } from "vitest";
import { cleanTrack } from "@/lib/clean";
import {
  DOWNWIND_TWA_MIN,
  UPWIND_TWA_MAX,
  computeSessionMetrics,
  directionStats,
  smoothedMaxSpeed,
  speedHistogram,
  timeWeightedMean,
} from "@/lib/metrics";
import { alignWind } from "@/lib/wind/align";
import { syntheticEnriched, syntheticMeta, syntheticRaw, manualWindModel } from "./helpers";

describe("time-weighted statistics", () => {
  it("weights by duration, not by sample count", () => {
    // 10 s at 2 m/s (1 Hz) then 20 s at 8 m/s (0.5 Hz): the fast stretch has fewer samples but
    // twice the duration, so the weighted mean must favour it.
    const points = syntheticEnriched(
      [
        { headingDeg: 0, speedMps: 2, seconds: 10, dtS: 1 },
        { headingDeg: 0, speedMps: 8, seconds: 20, dtS: 2 },
      ],
      { windFromDeg: 90 },
    );
    const weighted = timeWeightedMean(points, (p) => p.speed)!;
    const naive = points.reduce((a, p) => a + (p.speed ?? 0), 0) / points.length;
    // 10 s at 2 plus 20 s at 8 → 5.93 m/s weighted.
    expect(weighted).toBeGreaterThan(5.5);
    expect(weighted).toBeLessThan(6.3);
    expect(naive).toBeLessThan(weighted); // the naive mean under-weights the fast stretch
  });

  it("returns null when nothing is usable", () => {
    expect(timeWeightedMean([], (p) => p.speed)).toBeNull();
  });
});

describe("computeSessionMetrics", () => {
  it("reports distance, moving time and average speed consistently", () => {
    const points = syntheticEnriched([{ headingDeg: 0, speedMps: 6, seconds: 600 }], {
      windFromDeg: 90,
    });
    const m = computeSessionMetrics(points);
    expect(m.distanceM).toBeCloseTo(3600, -1.5);
    expect(m.movingTimeS).toBeCloseTo(599, 0);
    expect(m.avgSpeedMps!).toBeCloseTo(6.01, 1);
    // Average speed must equal distance / moving time by construction.
    expect(m.avgSpeedMps!).toBeCloseTo(m.distanceM / m.movingTimeS, 9);
  });

  it("excludes idle time from moving time", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: 0, speedMps: 0.05, seconds: 60 },
        { headingDeg: 0, speedMps: 7, seconds: 60 },
      ],
      { windFromDeg: 90 },
    );
    const m = computeSessionMetrics(points);
    expect(m.movingTimeS).toBeCloseTo(60, 0);
    expect(m.elapsedTimeS).toBeCloseTo(119, 0);
    expect(m.avgSpeedMps!).toBeGreaterThan(6.5);
  });

  it("uses a rolling window for maximum speed so one spike cannot win", () => {
    const points = syntheticEnriched([{ headingDeg: 0, speedMps: 7, seconds: 300 }], {
      windFromDeg: 90,
    });
    // One 16 m/s sample in an otherwise 7 m/s session.
    const spiked = points.map((p, i) => (i === 150 ? { ...p, speed: 16 } : p));
    const m = computeSessionMetrics(spiked);
    // A centred 3 s mean turns one 16 m/s outlier in a 7 m/s session into ~10 m/s, not 16.
    expect(m.maxSpeedMps!).toBeLessThanOrEqual(10.1);
    expect(m.maxSpeedMps!).toBeGreaterThan(6.9);
  });

  it("produces a speed histogram whose time sums to the moving time", () => {
    const points = syntheticEnriched([{ headingDeg: 0, speedMps: 5, seconds: 120 }], {
      windFromDeg: 90,
    });
    const buckets = speedHistogram(points, 0.5, 20);
    const total = buckets.reduce((a, b) => a + b.timeS, 0);
    expect(total).toBeCloseTo(119, 0);
  });
});

describe("smoothedMaxSpeed", () => {
  it("is null for an empty track", () => {
    expect(smoothedMaxSpeed([])).toBeNull();
  });
});

describe("directionStats (upwind / downwind VMG)", () => {
  const windFrom = 0; // wind from the north

  it("classifies heading north as upwind and heading south as downwind", () => {
    const upwind = syntheticEnriched([{ headingDeg: 0, speedMps: 6, seconds: 300 }], {
      windFromDeg: windFrom,
    });
    const downwind = syntheticEnriched([{ headingDeg: 180, speedMps: 9, seconds: 300 }], {
      windFromDeg: windFrom,
    });

    expect(upwind[10].twa!).toBeLessThan(3);
    expect(upwind[10].vmgUpMps!).toBeCloseTo(6, 0);
    expect(upwind[10].vmgDownMps!).toBeCloseTo(-6, 0);

    expect(downwind[10].twa!).toBeGreaterThan(177);
    expect(downwind[10].vmgUpMps!).toBeCloseTo(-9, 0);
    expect(downwind[10].vmgDownMps!).toBeCloseTo(9, 0);
  });

  it("computes the cosine rule for VMG at 45 degrees off the wind", () => {
    // Heading 45 with wind from 0 → TWA 45 → upwind VMG = 8 * cos(45) = 5.66
    const points = syntheticEnriched([{ headingDeg: 45, speedMps: 8, seconds: 200 }], {
      windFromDeg: 0,
    });
    const p = points[50];
    expect(p.twa!).toBeCloseTo(45, 1);
    expect(p.vmgUpMps!).toBeCloseTo(8 * Math.cos(Math.PI / 4), 1);
    expect(p.vmgDownMps!).toBeCloseTo(-8 * Math.cos(Math.PI / 4), 1);
  });

  it("splits time and distance between directions", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: 45, speedMps: 6, seconds: 300 }, // upwind
        { headingDeg: 135, speedMps: 9, seconds: 300 }, // downwind
      ],
      { windFromDeg: 0 },
    );
    const up = directionStats(points, "upwind");
    const down = directionStats(points, "downwind");
    expect(up.timeS).toBeCloseTo(300, -1);
    expect(down.timeS).toBeCloseTo(300, -1);
    expect(up.distanceM).toBeCloseTo(1800, -2);
    expect(down.distanceM).toBeCloseTo(2700, -2);
    expect(up.avgVmgMps!).toBeCloseTo(6 * Math.cos(Math.PI / 4), 1);
    expect(down.avgVmgMps!).toBeCloseTo(9 * Math.cos(Math.PI / 4), 1);
    // A beam reach belongs to neither bucket.
    expect(up.timeS + down.timeS).toBeLessThan(
      computeSessionMetrics(points).movingTimeS + 1,
    );
    expect(UPWIND_TWA_MAX).toBeLessThan(DOWNWIND_TWA_MIN);
  });

  it("is null-safe when there is no wind at all", () => {
    const points = syntheticEnriched([{ headingDeg: 45, speedMps: 6, seconds: 100 }], {
      windFromDeg: null,
    });
    expect(points.every((p) => p.twa === null)).toBe(true);
    const up = directionStats(points, "upwind");
    expect(up.timeS).toBe(0);
    expect(up.avgVmgMps).toBeNull();
  });
});

describe("wind alignment into metrics", () => {
  it("keeps elapsed time based on the file timestamps", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 5, seconds: 100 }]);
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    const enriched = alignWind(points, [], manualWindModel(0), {
      start: points[0].t,
      end: points[points.length - 1].t,
    });
    const m = computeSessionMetrics(enriched);
    expect(m.elapsedTimeS).toBeCloseTo(99, 0);
  });
});
