import { describe, expect, it } from "vitest";
import { cleanTrack } from "@/lib/clean";
import { bestEfforts, findEffort, hasVmgWindows } from "@/lib/bestWindows";
import { alignWind } from "@/lib/wind/align";
import { manualWindModel, syntheticEnriched, syntheticMeta, syntheticRaw } from "./helpers";

describe("bestEfforts", () => {
  it("returns nothing for a track with no intervals", () => {
    expect(bestEfforts([])).toEqual([]);
    expect(hasVmgWindows([])).toBe(false);
  });

  it("finds a constant effort across every window length", () => {
    const points = syntheticEnriched([{ headingDeg: 0, speedMps: 6, seconds: 600 }], {
      windFromDeg: 0,
    });
    const windows = bestEfforts(points);
    for (const minutes of [1, 2, 3]) {
      expect(findEffort(windows, "speed", minutes)!.meanMps).toBeCloseTo(6, 1);
      // Heading straight into the wind: all of the boat speed is made good upwind, and the
      // downwind component is the negative of it.
      expect(findEffort(windows, "vmgUp", minutes)!.meanMps).toBeCloseTo(6, 1);
      expect(findEffort(windows, "vmgDown", minutes)!.meanMps).toBeCloseTo(-6, 1);
    }
    expect(hasVmgWindows(windows)).toBe(true);
  });

  it("picks the fastest stretch, and mixes a longer window honestly", () => {
    // 5 minutes at 2 m/s, then a 2 minute burst at 10 m/s.
    const points = syntheticEnriched(
      [
        { headingDeg: 0, speedMps: 2, seconds: 300 },
        { headingDeg: 0, speedMps: 10, seconds: 120 },
      ],
      { windFromDeg: 0 },
    );
    const windows = bestEfforts(points);
    // The best minute sits entirely inside the burst.
    expect(findEffort(windows, "speed", 1)!.meanMps).toBeCloseTo(10, 1);
    // The best 3 minute window is the burst plus a minute of slow sailing:
    // (60 s * 2 + 120 s * 10) / 180 s = 7.33 m/s.
    const best3 = findEffort(windows, "speed", 3)!;
    expect(best3.meanMps).toBeGreaterThan(7.0);
    expect(best3.meanMps).toBeLessThan(7.7);
    // A best window is exactly its nominal length, never a truncated one.
    expect((best3.endT - best3.startT) / 1000).toBeCloseTo(180, 0);
    expect((findEffort(windows, "speed", 1)!.endT - findEffort(windows, "speed", 1)!.startT) / 1000)
      .toBeCloseTo(60, 0);
  });

  it("weights by time, not by sample count, on an unevenly sampled track", () => {
    // 60 s at 3 m/s at 1 Hz, then 3 minutes at 9 m/s at 0.25 Hz.
    const points = syntheticEnriched(
      [
        { headingDeg: 0, speedMps: 3, seconds: 60, dtS: 1 },
        { headingDeg: 0, speedMps: 9, seconds: 180, dtS: 4 },
      ],
      { windFromDeg: 0 },
    );
    const naive = points.reduce((a, p) => a + (p.speed ?? 0), 0) / points.length;
    const best1 = findEffort(bestEfforts(points), "speed", 1)!;
    // Counting samples would report ~5.6 m/s; the window must see the true 9 m/s.
    expect(naive).toBeLessThan(6);
    expect(best1.meanMps).toBeGreaterThan(8.8);
    expect(best1.coveredS).toBeGreaterThanOrEqual(30);
  });

  it("refuses to call a signal gap a best effort", () => {
    const raw = syntheticRaw([
      { headingDeg: 0, speedMps: 6, seconds: 60 },
      { headingDeg: 0, speedMps: 6, seconds: 60 },
    ]);
    // Push the second minute ten minutes into the future: one long gap between the two.
    for (let i = 60; i < raw.length; i++) raw[i].t += 600_000;
    const meta = syntheticMeta(raw);
    const { points } = cleanTrack(raw, meta, {});
    const enriched = alignWind(points, [], manualWindModel(0), {
      start: points[0].t,
      end: points[points.length - 1].t,
    });

    // A five minute window spans the gap but is only ~40% covered, so it does not exist.
    expect(bestEfforts(enriched, [5])).toEqual([]);
    // The one minute windows that are real still exist.
    expect(findEffort(bestEfforts(enriched, [1]), "speed", 1)!.meanMps).toBeCloseTo(6, 1);
  });

  it("reports the best VMG rather than the largest magnitude", () => {
    // Sailing dead downwind: upwind VMG is negative everywhere.
    const points = syntheticEnriched([{ headingDeg: 180, speedMps: 6, seconds: 600 }], {
      windFromDeg: 0,
    });
    const windows = bestEfforts(points);
    const up = findEffort(windows, "vmgUp", 1)!;
    const down = findEffort(windows, "vmgDown", 1)!;
    expect(up.meanMps).toBeCloseTo(-6, 1);
    expect(down.meanMps).toBeCloseTo(6, 1);
  });

  it("omits VMG windows entirely when there is no wind", () => {
    const points = syntheticEnriched([{ headingDeg: 0, speedMps: 6, seconds: 300 }], {});
    const windows = bestEfforts(points);
    expect(windows.every((w) => w.metric === "speed")).toBe(true);
    expect(hasVmgWindows(windows)).toBe(false);
    expect(findEffort(windows, "vmgUp", 1)).toBeNull();
  });

  it("orders its output by duration then by metric", () => {
    const points = syntheticEnriched([{ headingDeg: 0, speedMps: 6, seconds: 600 }], {
      windFromDeg: 0,
    });
    expect(bestEfforts(points).map((w) => `${w.minutes}:${w.metric}`)).toEqual([
      "1:speed",
      "1:vmgUp",
      "1:vmgDown",
      "2:speed",
      "2:vmgUp",
      "2:vmgDown",
      "3:speed",
      "3:vmgUp",
      "3:vmgDown",
    ]);
  });
});
