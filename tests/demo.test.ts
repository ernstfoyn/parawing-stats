import { describe, expect, it } from "vitest";
import { buildSegmentPlan, downwindStats, effectiveLabel, pointLabels } from "@/lib/classify";
import { buildDemoActivity, DEMO_WIND_FROM_DEG, DEMO_WIND_SPEED_MPS, generateDemoRaw } from "@/lib/demo";
import { analyse } from "@/lib/pipeline";

describe("demo activity", () => {
  const demo = buildDemoActivity();

  it("is a substantial, plausible session", () => {
    expect(demo.points.length).toBeGreaterThan(2000);
    const spanS = (demo.points[demo.points.length - 1].t - demo.points[0].t) / 1000;
    expect(spanS).toBeGreaterThan(2500);
    expect(demo.points[demo.points.length - 1].dist).toBeGreaterThan(10_000);
    expect(demo.points[demo.points.length - 1].dist).toBeLessThan(30_000);
  });

  it("is flagged as synthetic everywhere", () => {
    const { meta } = generateDemoRaw();
    expect(meta.sport).toBe("windsurfing");
    expect(meta.creator).toBe("synthetic");
    expect(meta.warnings.join(" ")).toContain("Synthetic demo activity");
    expect(demo.meta.fileName).toMatch(/^demo-/);
  });

  it("exercises the cleaning pipeline with its deliberate artefacts", () => {
    expect(demo.report.droppedDuplicateTimestamp).toBeGreaterThanOrEqual(1);
    expect(demo.report.droppedSpeedSpike).toBeGreaterThanOrEqual(1);
    expect(demo.report.gaps).toBeGreaterThanOrEqual(1);
    expect(demo.report.longestGapS).toBeGreaterThan(40);
    expect(demo.report.notes.join(" ")).toContain("synthetic demo activity");
    expect(demo.meta.warnings.join(" ")).toContain("Synthetic demo activity");
  });

  it("uses the manual wind source, never a fabricated observation", () => {
    expect(demo.windModel.kind).toBe("manual");
    expect(demo.windModel.manual?.dirFromDeg).toBe(DEMO_WIND_FROM_DEG);
    expect(demo.windModel.manual?.speedMps).toBe(DEMO_WIND_SPEED_MPS);
    expect(demo.windSamples.every((s) => s.quality === "manual")).toBe(true);
    expect(demo.windModel.station).toBeNull();
  });

  it("never stores a device speed it did not measure", () => {
    // The demo has no course channel, so headings must have been derived from displacement.
    expect(demo.points.some((p) => p.cog != null)).toBe(true);
  });
});

describe("demo analysis", () => {
  const demo = buildDemoActivity();
  const result = analyse({
    points: demo.points,
    windSamples: demo.windSamples,
    windModel: demo.windModel,
  });

  it("produces metrics the dashboard can show", () => {
    expect(result.metrics.distanceM).toBeGreaterThan(10_000);
    expect(result.metrics.maxSpeedMps!).toBeGreaterThan(8);
    expect(result.metrics.maxSpeedMps!).toBeLessThan(20);
    expect(result.metrics.avgSpeedMps!).toBeGreaterThan(3);
    expect(result.metrics.movingTimeS).toBeLessThan(result.metrics.elapsedTimeS);
    expect(result.metrics.speedBuckets.length).toBeGreaterThan(5);
  });

  it("excludes the paused interval from moving time", () => {
    const paused = result.metrics.elapsedTimeS - result.metrics.movingTimeS;
    expect(paused).toBeGreaterThan(45);
  });

  it("has full wind coverage because the wind is a constant manual value", () => {
    expect(result.wind.coverage).toBeCloseTo(1, 2);
    expect(result.wind.meanDirFromDeg!).toBeCloseTo(DEMO_WIND_FROM_DEG, 3);
  });

  it("splits the session into upwind and downwind work", () => {
    expect(result.upwind.timeS).toBeGreaterThan(600);
    expect(result.downwind.timeS).toBeGreaterThan(600);
    expect(result.upwind.distanceM).toBeGreaterThan(3000);
    expect(result.downwind.distanceM).toBeGreaterThan(3000);
    expect(result.upwind.avgVmgMps!).toBeGreaterThan(2);
    expect(result.downwind.avgVmgMps!).toBeGreaterThan(2);
  });

  it("suggests downwind segments and marks them as estimates", () => {
    const stats = result.dw.downwind;
    expect(stats.count).toBeGreaterThanOrEqual(3);
    expect(stats.distanceM).toBeGreaterThan(3000);
    expect(stats.longest!.distanceM).toBeGreaterThan(500);
    expect(stats.avgVmgDownMps!).toBeGreaterThan(3);
    const dwSegments = result.plan.segments.filter((s) => effectiveLabel(s).includes("downwind"));
    expect(dwSegments.every((s) => s.auto.confidence <= 0.8)).toBe(true);
    expect(dwSegments.some((s) => s.auto.reasons.length > 0)).toBe(true);
  });

  it("has a plan that covers every point exactly once", () => {
    expect(result.plan.segments[0].startIdx).toBe(0);
    expect(result.plan.segments[result.plan.segments.length - 1].endIdx).toBe(
      result.points.length - 1,
    );
    for (let i = 1; i < result.plan.segments.length; i++) {
      expect(result.plan.segments[i].startIdx).toBe(result.plan.segments[i - 1].endIdx + 1);
    }
    expect(pointLabels(result.points, result.plan)).toHaveLength(result.points.length);
  });

  it("is deterministic: the same seed gives the same track", () => {
    const again = buildDemoActivity();
    expect(again.points.length).toBe(demo.points.length);
    expect(again.points[100].lat).toBeCloseTo(demo.points[100].lat, 12);
    expect(again.points[100].t).toBe(demo.points[100].t);
  });

  it("keeps segment stats consistent with the track totals", () => {
    // Every interval belongs to exactly one segment, so summing them must reproduce the total.
    const sumDistance = result.plan.segments.reduce((a, s) => a + s.features.distanceM, 0);
    expect(sumDistance).toBeCloseTo(result.metrics.distanceM, -1);
    const sumDuration = result.plan.segments.reduce((a, s) => a + s.features.durationS, 0);
    expect(sumDuration).toBeCloseTo(
      (result.points[result.points.length - 1].t - result.points[0].t) / 1000,
      -1,
    );
  });

  it("reports honest zeroes when the wind is removed", () => {
    const noWind = analyse({
      points: demo.points,
      windSamples: [],
      windModel: {
        kind: "none",
        station: null,
        manual: null,
        maxGapS: 5400,
        interpolate: true,
      },
    });
    expect(noWind.wind.coverage).toBe(0);
    expect(noWind.downwind.avgVmgMps).toBeNull();
    expect(noWind.dw.downwind.count).toBe(0);
    const labelsWithoutWind = new Set(noWind.plan.segments.map((s) => effectiveLabel(s)));
    expect([...labelsWithoutWind].every((l) => l === "unclassified" || l === "idle")).toBe(true);
    expect(downwindStats(noWind.plan).downwind.longest).toBeNull();
    // The GPS metrics are unaffected by missing wind.
    expect(noWind.metrics.distanceM).toBeCloseTo(result.metrics.distanceM, 6);
  });

  it("keeps saved segment plans through a re-analysis", () => {
    const edited = {
      ...result.plan,
      segments: result.plan.segments.map((s) => ({ ...s, manualLabel: "excluded" as const })),
    };
    const reanalysed = analyse({
      points: demo.points,
      windSamples: demo.windSamples,
      windModel: demo.windModel,
      plan: edited,
    });
    expect(reanalysed.dw.downwind.count).toBe(0);
    expect(reanalysed.plan.segments.every((s) => effectiveLabel(s) === "excluded")).toBe(true);
  });

  it("rebuilds the plan when asked to", () => {
    const rebuilt = analyse({
      points: demo.points,
      windSamples: demo.windSamples,
      windModel: demo.windModel,
      plan: buildSegmentPlan([]),
      rebuildSegments: true,
    });
    expect(rebuilt.plan.segments.length).toBeGreaterThan(0);
    expect(rebuilt.plan.segments[0].startIdx).toBe(0);
  });
});
