import { describe, expect, it } from "vitest";
import { cleanTrack, deriveCourse } from "@/lib/clean";
import { haversineM } from "@/lib/geo";
import { syntheticMeta, syntheticRaw, T0 } from "./helpers";

describe("cleanTrack", () => {
  it("computes cumulative distance from timestamps and displacement", () => {
    // 600 s of 5 m/s straight north ≈ 3000 m (599 intervals between the first and last sample).
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 5, seconds: 600 }]);
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    expect(points).toHaveLength(600);
    expect(points[points.length - 1].dist).toBeGreaterThan(2980);
    expect(points[points.length - 1].dist).toBeLessThan(3000);
    expect(points[1].dt).toBeCloseTo(1, 6);
    expect(points[1].dd).toBeCloseTo(5, 1);
  });

  it("handles uneven sampling without assuming a fixed interval", () => {
    const raw = syntheticRaw([
      { headingDeg: 0, speedMps: 4, seconds: 30, dtS: 1 },
      { headingDeg: 0, speedMps: 4, seconds: 40, dtS: 2 },
      { headingDeg: 0, speedMps: 4, seconds: 30, dtS: 1 },
    ]);
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    // The dt=2 s stretch must show dt=2, and derived speed must stay at 4 m/s.
    const slowSample = points.find((p) => Math.abs(p.dt - 2) < 1e-6)!;
    expect(slowSample.dd / slowSample.dt).toBeCloseTo(4, 1);
    expect(points[points.length - 1].dist).toBeCloseTo(4 * 100, -1);
  });

  it("drops duplicate timestamps", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 5, seconds: 20 }]);
    raw.splice(5, 0, { ...raw[5] });
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    expect(report.droppedDuplicateTimestamp).toBe(1);
    expect(points).toHaveLength(20);
    expect(new Set(points.map((p) => p.t)).size).toBe(points.length);
  });

  it("drops invalid positions including 0/0", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 5, seconds: 10 }]);
    raw[3] = { ...raw[3], lat: 0, lon: 0 };
    raw[6] = { ...raw[6], lat: NaN, lon: 5 };
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    expect(report.droppedInvalidPosition).toBe(2);
    expect(points).toHaveLength(8);
  });

  it("rejects a single-sample GPS jump", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 8, seconds: 60 }]);
    // Teleport 250 m west for one sample, then back.
    const jumped = { ...raw[30], lon: raw[30].lon - 0.0046 };
    raw[30] = jumped;
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    expect(report.droppedSpeedSpike).toBe(1);
    expect(points).toHaveLength(59);
    // The remaining track must not contain a 250 m step anywhere.
    let maxStep = 0;
    for (let i = 1; i < points.length; i++) {
      maxStep = Math.max(maxStep, haversineM(points[i - 1], points[i]));
    }
    expect(maxStep).toBeLessThan(25);
  });

  it("rejects an impossible device speed but keeps the position", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 6, seconds: 30 }]);
    raw[10] = { ...raw[10], speed: 48 }; // 48 m/s = 93 kn, clearly corrupt
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    expect(points).toHaveLength(30);
    expect(points[10].speedFromDevice).toBe(false);
    expect(points[10].speed!).toBeLessThan(10);
    expect(report.notes.join(" ")).toContain("device speed");
  });

  it("rejects a device speed that is a wild outlier for the session", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 6, seconds: 60 * 5 }], {
      deviceSpeed: false,
    });
    raw[100] = { ...raw[100], speed: 22 }; // possible in isolation, absurd here
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    expect(points[100].speedFromDevice).toBe(false);
  });

  it("marks gaps and excludes them from moving time", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 6, seconds: 60 }], { deviceSpeed: false });
    // Remove 30 s of samples to simulate lost signal.
    raw.splice(20, 30);
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    const gapPoint = points.find((p) => p.gap)!;
    expect(gapPoint).toBeDefined();
    expect(gapPoint.dt).toBeCloseTo(31, 6);
    // Distance across the gap is still counted (the rider moved); speed is not invented.
    expect(gapPoint.speed).toBeNull();
    expect(report.gaps).toBe(1);
    expect(report.longestGapS).toBeGreaterThan(30);
  });

  it("keeps a device speed sample inside a gap, because that one is measured", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 6, seconds: 60 }]);
    raw.splice(20, 30);
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    const gapPoint = points.find((p) => p.gap)!;
    expect(gapPoint.speedFromDevice).toBe(true);
    expect(gapPoint.speed).toBeCloseTo(6, 1);
  });

  it("drops samples inside a device timer pause", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 6, seconds: 60 }]);
    const pauses = [{ start: T0 + 20_000, end: T0 + 40_000 }];
    const { points, report } = cleanTrack(raw, syntheticMeta(raw, { pauses }), { dropPaused: true });
    expect(report.droppedPaused).toBe(19);
    // The pause becomes one long gap, not 19 tiny ones, and it is never moving time.
    const gaps = points.filter((p) => p.gap);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].moving).toBe(false);
  });

  it("sorts out-of-order samples and reports them", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 5, seconds: 20 }]);
    const a = raw[5];
    raw[5] = raw[6];
    raw[6] = a;
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    expect(report.droppedOutOfOrder).toBe(1);
    for (let i = 1; i < points.length; i++) expect(points[i].t).toBeGreaterThan(points[i - 1].t);
  });

  it("derives course over ground from displacement when the file has none", () => {
    const raw = syntheticRaw([{ headingDeg: 45, speedMps: 7, seconds: 40 }]);
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    const mid = points[20];
    expect(mid.cog).not.toBeNull();
    expect(Math.abs(((mid.cog! - 45 + 540) % 360) - 180)).toBeLessThan(2);
    expect(mid.speed).toBeCloseTo(7, 1);
  });

  it("returns an empty track rather than inventing one", () => {
    const { points, report } = cleanTrack([], null);
    expect(points).toHaveLength(0);
    expect(report.kept).toBe(0);
    expect(report.notes.join(" ")).toContain("fewer than two");
  });

  it("keeps track of how many raw samples were dropped overall", () => {
    const raw = syntheticRaw([{ headingDeg: 0, speedMps: 5, seconds: 30 }]);
    raw.push({ ...raw[10] });
    raw.push({ ...raw[12], lat: 999 });
    const { points, report } = cleanTrack(raw, syntheticMeta(raw));
    expect(report.totalRaw).toBe(32);
    expect(report.kept).toBe(points.length);
    expect(report.kept).toBe(30);
  });
});

describe("deriveCourse", () => {
  it("smooths heading over the requested window", () => {
    const raw = syntheticRaw([{ headingDeg: 90, speedMps: 5, seconds: 20 }]);
    const course = deriveCourse(raw, 3);
    expect(course[10]!).toBeCloseTo(90, 0);
    expect(course[0]).not.toBeNull();
  });

  it("returns null when there is only one sample", () => {
    const raw = syntheticRaw([{ headingDeg: 90, speedMps: 5, seconds: 1 }]);
    expect(deriveCourse(raw, 3)[0]).toBeNull();
  });
});
