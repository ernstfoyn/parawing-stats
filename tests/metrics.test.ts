import { describe, expect, it } from "vitest";
import { cleanTrack } from "@/lib/clean";
import {
  DOWNWIND_TWA_MIN,
  UPWIND_TWA_MAX,
  computeSessionMetrics,
  directionStats,
  smoothedMaxSpeed,
  smoothedSpeeds,
  speedHistogram,
  stretchParts,
  tackParts,
  tackSide,
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

describe("stretchParts (how a stretch was turned)", () => {
  /** East for 30 s then south for 30 s: a quarter turn, at a chosen sampling interval. */
  function quarterTurn(dtS: number) {
    return syntheticEnriched(
      [
        { headingDeg: 90, speedMps: 6, seconds: 30, dtS },
        { headingDeg: 180, speedMps: 6, seconds: 30, dtS },
      ],
      { windFromDeg: 0 },
    );
  }

  it("measures the turn when the track is logged every second", () => {
    const points = quarterTurn(1);
    const parts = stretchParts(points, 0, points.length - 1, 4);
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(p.turnDeg).not.toBeNull();
    const net = parts.reduce((a, p) => a + (p.turnDeg ?? 0), 0);
    // East to south is a quarter turn to starboard, whichever way the slices land on it.
    expect(Math.abs(net)).toBeGreaterThan(45);
  });

  it("measures the turn on a sparsely sampled track instead of reporting zero", () => {
    // A real GPX logged every ~6 s gave a 57 s run only 8 fixes. Reading each slice's heading from
    // inside the slice made the entry and exit windows land on the same two fixes, so every slice
    // reported "0°" — a dead-straight reading of a stretch that visibly doubles back on the map.
    const points = quarterTurn(6);
    const parts = stretchParts(points, 0, points.length - 1, 4);
    const turns = parts.map((p) => p.turnDeg);
    expect(turns.filter((t) => t != null).length).toBeGreaterThan(0);
    expect(turns.some((t) => t != null && Math.abs(t) > 20)).toBe(true);
    const net = turns.reduce<number>((a, t) => a + (t ?? 0), 0);
    expect(Math.abs(net)).toBeGreaterThan(45);
  });

  it("reports no turn across a straight stretch, however sparsely it was logged", () => {
    for (const dtS of [1, 6]) {
      const points = syntheticEnriched(
        [{ headingDeg: 135, speedMps: 8, seconds: 120, dtS }],
        { windFromDeg: 0 },
      );
      const parts = stretchParts(points, 0, points.length - 1, 4);
      for (const p of parts) {
        expect(p.turnDeg).not.toBeNull();
        expect(Math.abs(p.turnDeg ?? 0)).toBeLessThan(5);
      }
    }
  });

  it("reads the heading at a slice boundary, so a one-fix slice is still measurable", () => {
    const points = quarterTurn(1);
    // Ten slices over 60 s: some slices hold only a couple of fixes.
    const parts = stretchParts(points, 0, points.length - 1, 10);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const p of parts) {
      expect(p.startIdx).toBeLessThanOrEqual(p.endIdx);
    }
    // Slices do not have to be equally long, but they must cover the run.
    expect(parts[0].startIdx).toBe(0);
    expect(parts[parts.length - 1].endIdx).toBe(points.length - 1);
  });
});

describe("smoothedSpeeds", () => {
  it("agrees with the session maximum it feeds", () => {
    const points = syntheticEnriched([{ headingDeg: 135, speedMps: 9, seconds: 60 }], {
      windFromDeg: 0,
    });
    const smoothed = smoothedSpeeds(points).filter((v): v is number => v != null);
    expect(smoothed.length).toBeGreaterThan(0);
    expect(Math.max(...smoothed)).toBeCloseTo(smoothedMaxSpeed(points)!, 6);
  });

  it("pulls a one-sample spike down, so the chart cannot claim a speed the headline does not", () => {
    const points = syntheticEnriched([{ headingDeg: 135, speedMps: 9, seconds: 60 }], {
      windFromDeg: 0,
    });
    // One absurd sample, as a GPS glitch leaves behind.
    points[30] = { ...points[30], speed: 60 };
    const smoothed = smoothedSpeeds(points).filter((v): v is number => v != null);
    expect(Math.max(...smoothed)).toBeLessThan(60);
    expect(smoothedMaxSpeed(points)!).toBeLessThan(60);
  });

  it("returns one entry per point, so a caller can zip it with the track", () => {
    const points = syntheticEnriched([{ headingDeg: 135, speedMps: 9, seconds: 30 }], {
      windFromDeg: 0,
    });
    expect(smoothedSpeeds(points)).toHaveLength(points.length);
  });
});

describe("tackSide", () => {
  it("calls the wind coming over the port side a port board", () => {
    // Heading NE with the wind from the north puts the wind on the rider's left.
    expect(tackSide(45, 0)).toBe("port");
    // Heading NW with the same wind puts it on the right.
    expect(tackSide(315, 0)).toBe("starboard");
  });

  it("says nothing when there is no heading to judge by", () => {
    expect(tackSide(null, 0)).toBeNull();
    expect(tackSide(45, null)).toBeNull();
    expect(tackSide(0, 0)).toBeNull();
  });
});

describe("tackParts (one board at a time)", () => {
  /**
   * A beat with two tacks: 60 s close-hauled on port, 60 s on starboard, 60 s back on port. Wind from
   * the north, so headings of 45 and 315 put the wind on opposite sides.
   */
  function beat() {
    return syntheticEnriched(
      [
        { headingDeg: 45, speedMps: 6, seconds: 60 },
        { headingDeg: 315, speedMps: 6, seconds: 60 },
        { headingDeg: 45, speedMps: 6, seconds: 60 },
      ],
      { windFromDeg: 0 },
    );
  }

  it("splits a beat into the boards it was actually sailed in", () => {
    const points = beat();
    const parts = tackParts(points, 0, points.length - 1);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const sides = parts.map((p) => p.side);
    expect(sides).toContain("port");
    expect(sides).toContain("starboard");
    // Alternating, never two boards of the same side in a row.
    for (let i = 1; i < sides.length; i++) expect(sides[i]).not.toBe(sides[i - 1]);
  });

  it("gives each board its own distance, time and VMG, which is the point of splitting", () => {
    const points = beat();
    const parts = tackParts(points, 0, points.length - 1);
    for (const p of parts) {
      expect(p.durationS).toBeGreaterThanOrEqual(20);
      expect(p.distanceM).toBeGreaterThan(0);
      expect(p.avgSpeedMps).toBeCloseTo(6, 0);
      // At TWA 45 the upwind VMG is 6 * cos(45) = 4.24.
      expect(p.avgVmgUpMps!).toBeGreaterThan(3.5);
      expect(p.avgTwaDeg!).toBeGreaterThan(40);
      expect(p.avgTwaDeg!).toBeLessThan(50);
    }
  });

  it("does not turn a flick through the wind into a board of its own", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: 45, speedMps: 6, seconds: 60 },
        { headingDeg: 315, speedMps: 6, seconds: 3 }, // a wobble across the wind
        { headingDeg: 45, speedMps: 6, seconds: 60 },
      ],
      { windFromDeg: 0 },
    );
    const parts = tackParts(points, 0, points.length - 1);
    expect(parts.every((p) => p.durationS >= 20)).toBe(true);
  });

  it("returns nothing rather than one invented board when there is no wind", () => {
    const points = syntheticEnriched([{ headingDeg: 45, speedMps: 6, seconds: 60 }], {
      windFromDeg: null,
    });
    expect(tackParts(points, 0, points.length - 1)).toEqual([]);
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
