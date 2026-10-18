import { describe, expect, it } from "vitest";
import { haversineM } from "@/lib/geo";
import { analyse } from "@/lib/pipeline";
import { manualSamples, summariseAligned, trueWindAngle, vmg, windAt } from "@/lib/wind/align";
import type { TrackPoint, WindSample } from "@/lib/types";
import { syntheticEnriched, manualWindModel, T0 } from "./helpers";

function sample(t: number, speedMps: number | null, dirFromDeg: number | null, quality: "measured" | "modelled" | "manual" = "measured"): WindSample {
  return { t, speedMps, gustMps: null, dirFromDeg, quality, providerId: "test", stationId: "S1" };
}

describe("trueWindAngle", () => {
  it("wraps around 0/360", () => {
    expect(trueWindAngle(350, 10)).toBeCloseTo(20, 6);
    expect(trueWindAngle(10, 350)).toBeCloseTo(20, 6);
    expect(trueWindAngle(0, 0)).toBeCloseTo(0, 6);
    expect(trueWindAngle(180, 0)).toBeCloseTo(180, 6);
    expect(trueWindAngle(90, 0)).toBeCloseTo(90, 6);
  });

  it("is null without both inputs", () => {
    expect(trueWindAngle(null, 10)).toBeNull();
    expect(trueWindAngle(10, null)).toBeNull();
  });
});

describe("vmg", () => {
  it("is positive upwind when heading into the wind", () => {
    expect(vmg(10, 0, "up")).toBeCloseTo(10, 6);
    expect(vmg(10, 0, "down")).toBeCloseTo(-10, 6);
  });

  it("is positive downwind when running away from the wind", () => {
    expect(vmg(10, 180, "down")).toBeCloseTo(10, 6);
    expect(vmg(10, 180, "up")).toBeCloseTo(-10, 6);
  });

  it("is zero on a beam reach", () => {
    expect(vmg(10, 90, "up")!).toBeCloseTo(0, 6);
    expect(vmg(10, 90, "down")!).toBeCloseTo(0, 6);
  });

  it("never exceeds boat speed", () => {
    for (let twa = 0; twa <= 180; twa += 5) {
      expect(Math.abs(vmg(7.5, twa, "up")!)).toBeLessThanOrEqual(7.5 + 1e-9);
      expect(Math.abs(vmg(7.5, twa, "down")!)).toBeLessThanOrEqual(7.5 + 1e-9);
    }
  });
});

describe("windAt", () => {
  const samples = [sample(T0, 8, 300), sample(T0 + 3_600_000, 10, 320)];

  it("returns the exact observation on a timestamp", () => {
    const w = windAt(T0, samples, 5400, true);
    expect(w.interp).toBe("exact");
    expect(w.speedMps).toBe(8);
    expect(w.dirFromDeg).toBe(300);
  });

  it("interpolates speeds linearly and directions circularly", () => {
    const w = windAt(T0 + 1_800_000, samples, 5400, true);
    expect(w.interp).toBe("interpolated");
    expect(w.speedMps).toBeCloseTo(9, 6);
    expect(w.dirFromDeg).toBeCloseTo(310, 6);
  });

  it("interpolates across the 0/360 boundary the short way", () => {
    const wrap = [sample(T0, 8, 350), sample(T0 + 3_600_000, 8, 10)];
    const w = windAt(T0 + 1_800_000, wrap, 5400, true);
    expect(w.dirFromDeg!).toBeCloseTo(0, 6);
    expect(Math.abs(w.dirFromDeg! - 180)).toBeGreaterThan(170); // not the long way
  });

  it("falls back to the nearest observation when interpolation is off", () => {
    const w = windAt(T0 + 600_000, samples, 5400, false);
    expect(w.interp).toBe("nearest");
    expect(w.speedMps).toBe(8);
  });

  it("reports missing wind beyond the tolerance window instead of extrapolating", () => {
    const far = windAt(T0 + 8 * 3_600_000, samples, 5400, true);
    expect(far.interp).toBe("none");
    expect(far.speedMps).toBeNull();
    expect(far.dirFromDeg).toBeNull();
    expect(far.quality).toBeNull();
  });

  it("handles a single observation with no bracketing pair", () => {
    const one = [sample(T0, 7, 90)];
    expect(windAt(T0, one, 5400, true).speedMps).toBe(7);
    expect(windAt(T0 + 200_000, one, 5400, true).interp).toBe("nearest");
    expect(windAt(T0 + 30 * 3_600_000, one, 5400, true).interp).toBe("none");
  });

  it("handles an empty observation set", () => {
    expect(windAt(T0, [], 5400, true).speedMps).toBeNull();
  });

  it("supports observations that arrive unsorted", () => {
    const messy = [sample(T0 + 3_600_000, 10, 320), sample(T0, 8, 300)];
    expect(windAt(T0, messy, 5400, true).speedMps).toBe(8);
  });

  it("keeps a missing direction missing while still using the speed", () => {
    const partial = [sample(T0, 9, null), sample(T0 + 3_600_000, 11, 280)];
    const w = windAt(T0, partial, 5400, true);
    expect(w.speedMps).toBe(9);
    expect(w.dirFromDeg).toBeNull();
  });
});

describe("manual wind", () => {
  it("creates a constant wind across the session", () => {
    const s = manualSamples({ speedMps: 9, dirFromDeg: 300, gustMps: 12 }, { start: T0, end: T0 + 600_000 });
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.quality === "manual")).toBe(true);
    const w = windAt(T0 + 300_000, s, 3600, true);
    expect(w.speedMps).toBe(9);
    expect(w.dirFromDeg).toBe(300);
    expect(w.gustMps).toBe(12);
    expect(w.interp).toBe("interpolated");
  });

  it("is marked as manual everywhere it is used", () => {
    const points = syntheticEnriched([{ headingDeg: 45, speedMps: 6, seconds: 60 }], {
      windFromDeg: 300,
    });
    expect(points.every((p) => p.windQuality === "manual")).toBe(true);
    expect(points.every((p) => p.windDirFromDeg === 300)).toBe(true);
  });
});

describe("summariseAligned", () => {
  it("means directions circularly and reports coverage", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: 45, speedMps: 6, seconds: 60 },
        { headingDeg: 168, speedMps: 9, seconds: 60 },
      ],
      { windFromDeg: 300, windSpeedMps: 8 },
    );
    const s = summariseAligned(points);
    expect(s.avgSpeedMps!).toBeCloseTo(8, 6);
    expect(s.meanDirFromDeg!).toBeCloseTo(300, 6);
    expect(s.coverage).toBeCloseTo(1, 3);
    expect(s.observationCount).toBeGreaterThan(50);
  });

  it("reports zero coverage when there is no wind", () => {
    const points = syntheticEnriched([{ headingDeg: 45, speedMps: 6, seconds: 60 }], {
      windFromDeg: null,
    });
    const s = summariseAligned(points);
    expect(s.coverage).toBe(0);
    expect(s.avgSpeedMps).toBeNull();
    expect(s.meanDirFromDeg).toBeNull();
  });
});

describe("analyse() end to end", () => {
  it("produces metrics, segments and wind summary from a cleaned track", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: 45, speedMps: 6, seconds: 300 },
        { headingDeg: 168, speedMps: 9, seconds: 300 },
      ],
      { windFromDeg: 0 },
    );
    const cleaned: TrackPoint[] = points.map((p) => ({
      t: p.t,
      lat: p.lat,
      lon: p.lon,
      ele: p.ele,
      hr: p.hr,
      speed: p.speed,
      speedFromDevice: p.speedFromDevice,
      cog: p.cog,
      dist: p.dist,
      dt: p.dt,
      dd: p.dd,
      moving: p.moving,
      gap: p.gap,
    }));
    const result = analyse({
      points: cleaned,
      windSamples: [],
      windModel: manualWindModel(0),
    });
    expect(result.points).toHaveLength(cleaned.length);
    expect(result.metrics.distanceM).toBeGreaterThan(3000);
    expect(result.plan.segments.length).toBeGreaterThanOrEqual(2);
    expect(result.dw.downwind.distanceM).toBeGreaterThan(2000);
    expect(result.wind.coverage).toBeCloseTo(1, 3);
    expect(haversineM(
      { lat: result.points[0].lat, lon: result.points[0].lon },
      { lat: result.points[1].lat, lon: result.points[1].lon },
    )).toBeGreaterThan(0);
  });
});
