import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASSIFY_OPTIONS,
  buildSegmentPlan,
  carryManualLabels,
  downwindStats,
  effectiveLabel,
  isMeasuredIdle,
  labelRange,
  mergeSegments,
  planCoversTrack,
  pointLabels,
  resetToAuto,
  scoreDownwindKind,
  segmentFeatures,
  setSegmentLabel,
  splitSegment,
} from "@/lib/classify";
import type { SegmentFeatures } from "@/lib/types";
import { cleanTrack } from "@/lib/clean";
import { alignWind } from "@/lib/wind/align";
import { manualWindModel, syntheticEnriched, syntheticMeta, syntheticRaw } from "./helpers";

const UPWIND = 45; // heading 45 with wind from 0 → TWA 45
// A leg deep enough to be a real run: the rule requires the course to *ride* past 150°, where a
// flying parawing cannot hold at all, so a dead-straight 135° is a broad reach and not a run.
const DOWNWIND = 168; // → TWA 168
const DEEP = 180; // → TWA 180

describe("buildSegmentPlan", () => {
  it("covers the whole track with contiguous segments", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: UPWIND, speedMps: 6, seconds: 120 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 120 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    expect(planCoversTrack(plan, points.length)).toBe(true);
    expect(plan.segments[0].startIdx).toBe(0);
    expect(plan.segments[plan.segments.length - 1].endIdx).toBe(points.length - 1);
  });

  it("labels an upwind leg and a downwind leg differently", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: UPWIND, speedMps: 6, seconds: 120 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 120 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    const labels = plan.segments.map((s) => effectiveLabel(s));
    expect(labels[0]).toBe("upwind");
    expect(labels[labels.length - 1]).toMatch(/downwind/);
  });

  it("does not merge separate downwind runs across an upwind leg", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 90 },
        { headingDeg: UPWIND, speedMps: 6, seconds: 90 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 90 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    const dw = plan.segments.filter((s) => effectiveLabel(s).includes("downwind"));
    expect(dw.length).toBe(2);
    // The middle of the track (the upwind leg) must not be part of a downwind segment.
    const middle = Math.floor(points.length / 2);
    expect(dw.some((s) => middle >= s.startIdx && middle <= s.endIdx)).toBe(false);
  });

  it("keeps a brief slow patch inside a downwind run instead of splitting it", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 60 },
        { headingDeg: DOWNWIND, speedMps: 0.4, seconds: 5 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 60 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    const dw = plan.segments.filter((s) => effectiveLabel(s).includes("downwind"));
    expect(dw).toHaveLength(1);
    expect(dw[0].features.durationS).toBeGreaterThan(120);
  });

  it("does split when the interruption is long enough to matter", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 60 },
        { headingDeg: UPWIND, speedMps: 6, seconds: 60 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 60 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    expect(plan.segments.filter((s) => effectiveLabel(s).includes("downwind"))).toHaveLength(2);
  });

  it("uses the TWA thresholds as boundaries", () => {
    const justBelow = syntheticEnriched([{ headingDeg: 105, speedMps: 8, seconds: 60 }], {
      windFromDeg: 0,
    });
    const justAbove = syntheticEnriched([{ headingDeg: 115, speedMps: 8, seconds: 60 }], {
      windFromDeg: 0,
    });
    const a = buildSegmentPlan(justBelow).segments.map((s) => effectiveLabel(s));
    const b = buildSegmentPlan(justAbove).segments.map((s) => effectiveLabel(s));
    expect(a).toContain("reaching");
    expect(b.some((l) => l.includes("downwind"))).toBe(true);
  });

  it("marks a deep run as downwind and a course just past the beam as a powered reach", () => {
    const deep = syntheticEnriched([{ headingDeg: DEEP, speedMps: 12, seconds: 90 }], {
      windFromDeg: 0,
    });
    // TWA 120°: past the beam, but outside the 55° window that the rider counts as a run.
    const broad = syntheticEnriched([{ headingDeg: 120, speedMps: 8, seconds: 90 }], {
      windFromDeg: 0,
    });
    const deepPlan = buildSegmentPlan(deep);
    const broadPlan = buildSegmentPlan(broad);
    expect(effectiveLabel(deepPlan.segments[deepPlan.segments.length - 1])).toBe("free_downwind");
    expect(effectiveLabel(broadPlan.segments[broadPlan.segments.length - 1])).toBe(
      "powered_downwind",
    );
  });

  it("never claims more than 80% confidence about the parawing's state", () => {
    const points = syntheticEnriched([{ headingDeg: DEEP, speedMps: 13, seconds: 90 }], {
      windFromDeg: 0,
    });
    const plan = buildSegmentPlan(points);
    for (const s of plan.segments) expect(s.auto.confidence).toBeLessThanOrEqual(0.8);
    const reasons = plan.segments.flatMap((s) => s.auto.reasons).join(" ");
    expect(reasons).toContain("Estimate only");
  });

  it("classifies everything as unclassified when there is no wind", () => {
    const points = syntheticEnriched([{ headingDeg: DEEP, speedMps: 9, seconds: 60 }], {
      windFromDeg: null,
    });
    const plan = buildSegmentPlan(points);
    expect(plan.segments.every((s) => effectiveLabel(s) === "unclassified")).toBe(true);
  });

  it("returns an empty plan for an empty track", () => {
    const plan = buildSegmentPlan([]);
    expect(plan.segments).toEqual([]);
  });

  it("never calls a recording dropout idle", () => {
    // 30 s of samples removed: the watch stopped, so there is no speed and no course. The old rule
    // read `!p.moving` as idle, which every gap point satisfies, so a hole in the file was reported
    // as the rider lying still.
    const raw = syntheticRaw([{ headingDeg: DOWNWIND, speedMps: 9, seconds: 60 }], {
      deviceSpeed: false,
    });
    raw.splice(20, 30);
    const meta = syntheticMeta(raw);
    const { points } = cleanTrack(raw, meta);
    const enriched = alignWind(points, [], manualWindModel(0, 8), {
      start: points[0].t,
      end: points[points.length - 1].t,
    });

    const atGap = enriched.find((p) => p.gap)!;
    expect(atGap).toBeDefined();
    expect(atGap.speed).toBeNull();
    expect(isMeasuredIdle(atGap)).toBe(false);
    // And the plan must not turn it into an idle stretch either.
    const plan = buildSegmentPlan(enriched);
    for (const s of plan.segments) {
      if (effectiveLabel(s) !== "idle") continue;
      const measured = enriched
        .slice(s.startIdx, s.endIdx + 1)
        .some((p) => isMeasuredIdle(p));
      expect(measured).toBe(true);
    }
  });

  it("still calls a measured crawl idle, so the rule is about measurement and not caution", () => {
    const points = syntheticEnriched([{ headingDeg: DOWNWIND, speedMps: 0.3, seconds: 60 }], {
      windFromDeg: 0,
    });
    expect(isMeasuredIdle(points[10])).toBe(true);
    expect(effectiveLabel(buildSegmentPlan(points).segments[0])).toBe("idle");
  });

  it("reports how much of a stretch the watch did not record", () => {
    const raw = syntheticRaw([{ headingDeg: DOWNWIND, speedMps: 9, seconds: 90 }], {
      deviceSpeed: false,
    });
    raw.splice(30, 25);
    const { points } = cleanTrack(raw, syntheticMeta(raw));
    const enriched = alignWind(points, [], manualWindModel(0, 8), {
      start: points[0].t,
      end: points[points.length - 1].t,
    });
    const whole = segmentFeatures(enriched, 0, enriched.length - 1);
    expect(whole.gapS).toBeGreaterThan(20);
    expect(whole.gapS).toBeLessThan(whole.durationS);
  });

  it("still calls a measured crawl idle", () => {
    // A real measurement of 0.3 m/s is idle, and must stay idle: the rule is about what was
    // measured, not about being cautious.
    const points = syntheticEnriched([{ headingDeg: DOWNWIND, speedMps: 0.3, seconds: 60 }], {
      windFromDeg: 0,
    });
    const plan = buildSegmentPlan(points);
    expect(effectiveLabel(plan.segments[0])).toBe("idle");
  });

  it("clearly labels idle pumping in the shore break", () => {
    const points = syntheticEnriched([{ headingDeg: 90, speedMps: 1.2, seconds: 60 }], {
      windFromDeg: 0,
    });
    const plan = buildSegmentPlan(points);
    expect(effectiveLabel(plan.segments[0])).toBe("idle");
  });
});

describe("segmentFeatures", () => {
  it("measures duration, distance, speed and TWA", () => {
    const points = syntheticEnriched([{ headingDeg: DOWNWIND, speedMps: 9, seconds: 120 }], {
      windFromDeg: 0,
    });
    const f = segmentFeatures(points, 0, points.length - 1);
    expect(f.durationS).toBeCloseTo(119, 0);
    expect(f.distanceM).toBeCloseTo(9 * 119, -2);
    expect(f.avgSpeedMps).toBeCloseTo(9, 1);
    expect(f.avgTwaDeg).toBeCloseTo(168, 1);
    expect(f.movingFraction).toBeCloseTo(1, 2);
    expect(f.avgWindSpeedMps).toBeCloseTo(8, 1);
  });
});

describe("scoreDownwindKind", () => {
  const base: SegmentFeatures = {
    durationS: 120,
    distanceM: 1000,
    avgSpeedMps: 10,
    maxSpeedMps: 12,
    avgTwaDeg: 175,
    headingSpread: 0.1,
    avgVmgDownMps: 9.5,
    deadRunFraction: 0.8,
    movingFraction: 1,
    familyShare: 1,
    deepShare: 1,
    deepDwellS: 120,
    veryDeepS: 120,
    gapS: 0,
    avgWindSpeedMps: 9,
  };

  it("prefers free surfing for deep, fast runs", () => {
    expect(scoreDownwindKind(base, 10, 1).label).toBe("free_downwind");
  });

  it("prefers a powered reach for a broad course that never gets near a run", () => {
    const broad = {
      ...base,
      avgTwaDeg: 118,
      deadRunFraction: 0,
      avgSpeedMps: 6,
      deepShare: 0,
      deepDwellS: 0,
      veryDeepS: 0,
      familyShare: 1,
    };
    expect(scoreDownwindKind(broad, 10, 1).label).toBe("powered_downwind");
  });

  it("decides on the angle held over time, not on the average angle", () => {
    // The rider's own correction. What makes a run is the angle the stretch *holds*: at least two
    // thirds of its measured time beyond 125°, or one unbroken spell of 90 s there.
    const dip = { ...base, avgTwaDeg: 130, deepShare: 0.5, deepDwellS: 30 };
    expect(scoreDownwindKind(dip, 10, 1).label).toBe("powered_downwind");

    const held = { ...base, avgTwaDeg: 130, deepShare: 0.7, deepDwellS: 30 };
    expect(scoreDownwindKind(held, 10, 1).label).toBe("free_downwind");

    // Or one long unbroken spell, even if the rest of the stretch was shallower.
    const longDwell = { ...base, avgTwaDeg: 128, deepShare: 0.4, deepDwellS: 95 };
    expect(scoreDownwindKind(longDwell, 10, 1).label).toBe("free_downwind");

    // But holding the angle is not enough on its own: the stretch has to have ridden deep. A broad
    // reach held straight at 133° passes the share test and is still not a run, because a wing cannot
    // hold past 150° at all and a wave would have carried the rider there. On the rider's own session
    // that stretch spent 1 s past 150° where every run spent 30-72% of its time there.
    const straightBroadReach = { ...base, avgTwaDeg: 133, deepShare: 0.72, deepDwellS: 70, veryDeepS: 1 };
    const notARun = scoreDownwindKind(straightBroadReach, 10, 1);
    expect(notARun.label).toBe("powered_downwind");
    expect(notARun.reasons.join(" ")).toContain("past 150°");

    // And the shape that started this: a broad reach that only dips deep at its end. Its mean sits in
    // the downwind family, which is exactly why the mean was the wrong thing to decide on.
    const tail = { ...base, avgTwaDeg: 121, deepShare: 0.3, deepDwellS: 26, familyShare: 0.3 };
    const guess = scoreDownwindKind(tail, 10, 1);
    expect(guess.label).toBe("powered_downwind");
    expect(guess.reasons.join(" ")).toContain("Only 30% of it was even in the downwind family");
  });

  it("lowers confidence when wind coverage is poor", () => {
    const good = scoreDownwindKind(base, 10, 1).confidence;
    const poor = scoreDownwindKind({ ...base, avgTwaDeg: 148, deepShare: 0.85 }, 10, 0.2).confidence;
    expect(poor).toBeLessThan(good);
  });

  it("never claims more than 80% confidence, and says it is an estimate", () => {
    const guess = scoreDownwindKind(base, 10, 1);
    expect(guess.confidence).toBeLessThanOrEqual(0.8);
    expect(guess.reasons.join(" ")).toContain("Estimate only");
  });
});

describe("manual editing", () => {
  const build = () =>
    syntheticEnriched(
      [
        { headingDeg: UPWIND, speedMps: 6, seconds: 90 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 90 },
        { headingDeg: UPWIND, speedMps: 6, seconds: 90 },
      ],
      { windFromDeg: 0 },
    );

  it("marks a segment as free downwind surfing", () => {
    const points = build();
    const plan = buildSegmentPlan(points);
    const dw = plan.segments.find((s) => effectiveLabel(s).includes("downwind"))!;
    const edited = setSegmentLabel(plan, dw.id, "free_downwind");
    expect(effectiveLabel(edited.segments.find((s) => s.id === dw.id)!)).toBe("free_downwind");
    expect(downwindStats(edited).downwind.count).toBe(1);
  });

  it("excludes a segment from the statistics", () => {
    const points = build();
    let plan = buildSegmentPlan(points);
    const dw = plan.segments.find((s) => effectiveLabel(s).includes("downwind"))!;
    expect(downwindStats(plan).downwind.count).toBe(1);
    plan = setSegmentLabel(plan, dw.id, "excluded");
    expect(downwindStats(plan).downwind.count).toBe(0);
    expect(downwindStats(plan).downwind.distanceM).toBe(0);
  });

  it("splits a segment in two and keeps the plan covering the track", () => {
    const points = build();
    const plan = buildSegmentPlan(points);
    const dw = plan.segments.find((s) => effectiveLabel(s).includes("downwind"))!;
    const mid = Math.floor((dw.startIdx + dw.endIdx) / 2);
    const split = splitSegment(plan, points, dw.id, mid);
    expect(planCoversTrack(split, points.length)).toBe(true);
    const parts = split.segments.filter((s) => s.startIdx === dw.startIdx || s.endIdx === dw.endIdx);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(splitsAreAdjacent(split)).toBe(true);
    // Statistics are recalculated immediately: the half relabelled as a powered reach is counted
    // separately from the half left as a downwind run.
    const half = split.segments.find((s) => s.startIdx === mid)!;
    const relabelled = setSegmentLabel(split, half.id, "powered_downwind");
    expect(downwindStats(relabelled).downwind.count).toBe(1);
    expect(downwindStats(relabelled).poweredReach.count).toBe(1);
  });

  it("ignores a split outside the segment", () => {
    const points = build();
    const plan = buildSegmentPlan(points);
    const seg = plan.segments[0];
    expect(splitSegment(plan, points, seg.id, 0)).toBe(plan);
    expect(splitSegment(plan, points, seg.id, points.length + 5)).toBe(plan);
  });

  it("merges a segment with its neighbour", () => {
    const points = build();
    const plan = buildSegmentPlan(points);
    const second = plan.segments[1];
    const merged = mergeSegments(plan, points, second.id, "prev");
    expect(merged.segments.length).toBe(plan.segments.length - 1);
    expect(planCoversTrack(merged, points.length)).toBe(true);
    expect(splitsAreAdjacent(merged)).toBe(true);
  });

  it("merges across the whole track when asked repeatedly", () => {
    const points = build();
    let plan = buildSegmentPlan(points);
    while (plan.segments.length > 1) {
      plan = mergeSegments(plan, points, plan.segments[1].id, "prev");
    }
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].startIdx).toBe(0);
    expect(plan.segments[0].endIdx).toBe(points.length - 1);
  });

  it("does nothing when merging past the ends", () => {
    const points = build();
    const plan = buildSegmentPlan(points);
    expect(mergeSegments(plan, points, plan.segments[0].id, "prev")).toBe(plan);
    expect(
      mergeSegments(plan, points, plan.segments[plan.segments.length - 1].id, "next"),
    ).toBe(plan);
  });

  it("labels an arbitrary index range, splitting and merging as needed", () => {
    const points = build();
    let plan = buildSegmentPlan(points);
    const from = Math.floor(points.length * 0.25);
    const to = Math.floor(points.length * 0.75);
    plan = labelRange(plan, points, from, to, "free_downwind");
    expect(planCoversTrack(plan, points.length)).toBe(true);
    const labeled = plan.segments.find((s) => s.startIdx <= from && s.endIdx >= to)!;
    expect(effectiveLabel(labeled)).toBe("free_downwind");
    expect(labeled.startIdx).toBe(from);
    expect(labeled.endIdx).toBe(to);
    const stats = downwindStats(plan);
    expect(stats.downwind.count).toBe(1);
    expect(stats.downwind.distanceM).toBeGreaterThan(0);
  });

  it("resets every manual correction", () => {
    const points = build();
    let plan = buildSegmentPlan(points);
    plan = labelRange(plan, points, 10, points.length - 10, "excluded");
    expect(plan.segments.some((s) => s.manualLabel != null)).toBe(true);
    const reset = resetToAuto(plan);
    expect(reset.segments.every((s) => s.manualLabel === null)).toBe(true);
  });

  it("recalculates features after an edit", () => {
    const points = build();
    const plan = buildSegmentPlan(points);
    const dw = plan.segments.find((s) => effectiveLabel(s).includes("downwind"))!;
    const mid = Math.floor((dw.startIdx + dw.endIdx) / 2);
    const split = splitSegment(plan, points, dw.id, mid);
    const left = split.segments.find((s) => s.startIdx === dw.startIdx)!;
    const right = split.segments.find((s) => s.endIdx === dw.endIdx)!;
    expect(left.features.durationS).toBeGreaterThan(0);
    expect(right.features.durationS).toBeGreaterThan(0);
    // Splitting is lossless: the two halves add up to the original, to within one sample.
    expect(left.features.durationS + right.features.durationS).toBeCloseTo(
      dw.features.durationS,
      0,
    );
    expect(left.features.distanceM + right.features.distanceM).toBeCloseTo(
      dw.features.distanceM,
      -1,
    );
  });
});

describe("downwindStats", () => {
  it("aggregates distance, duration, speed and the longest run", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 100 },
        { headingDeg: UPWIND, speedMps: 6, seconds: 100 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 200 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    const stats = downwindStats(plan);
    expect(stats.downwind.count).toBe(2);
    // Two downwind runs of ~100 s and ~200 s at 9 m/s.
    expect(stats.downwind.distanceM).toBeGreaterThan(2500);
    expect(stats.downwind.distanceM).toBeLessThan(2800);
    expect(stats.downwind.durationS).toBeGreaterThan(290);
    expect(stats.downwind.durationS).toBeLessThan(310);
    expect(stats.downwind.avgSpeedMps).toBeCloseTo(9, 1);
    expect(stats.downwind.longest!.durationS).toBeGreaterThan(190);
    expect(stats.downwind.longest!.distanceM).toBeGreaterThan(stats.downwind.distanceM / 2);
    expect(stats.downwind.avgVmgDownMps!).toBeGreaterThan(5);
  });

  it("returns zeros for a session with no downwind", () => {
    const points = syntheticEnriched([{ headingDeg: UPWIND, speedMps: 6, seconds: 120 }], {
      windFromDeg: 0,
    });
    const stats = downwindStats(buildSegmentPlan(points));
    expect(stats.downwind.count).toBe(0);
    expect(stats.downwind.distanceM).toBe(0);
    expect(stats.downwind.longest).toBeNull();
    expect(stats.downwind.avgVmgDownMps).toBeNull();
  });

  it("ignores a stretch too short to count as a run", () => {
    // 35 s at 2.5 m/s is about 87 m: real downwind riding, but under the 100 m floor, so it must
    // not pad the run count or the downwind distance. The table and the map badges use the same
    // floor via `segmentRuns`, so all three always agree.
    const points = syntheticEnriched(
      [
        { headingDeg: DOWNWIND, speedMps: 2.5, seconds: 35 },
        { headingDeg: UPWIND, speedMps: 6, seconds: 120 },
      ],
      { windFromDeg: 0 },
    );
    const stats = downwindStats(buildSegmentPlan(points));
    expect(stats.downwind.count).toBe(0);
    expect(stats.downwind.distanceM).toBe(0);
  });
});

describe("pointLabels", () => {
  it("gives every point the label of its segment", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: UPWIND, speedMps: 6, seconds: 90 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 90 },
      ],
      { windFromDeg: 0 },
    );
    const plan = buildSegmentPlan(points);
    const labels = pointLabels(points, plan);
    expect(labels).toHaveLength(points.length);
    expect(labels[10]).toBe("upwind");
    expect(labels[labels.length - 5]).toMatch(/downwind/);
  });
});

function splitsAreAdjacent(plan: { segments: { startIdx: number; endIdx: number }[] }): boolean {
  for (let i = 1; i < plan.segments.length; i++) {
    if (plan.segments[i].startIdx !== plan.segments[i - 1].endIdx + 1) return false;
  }
  return true;
}

describe("constants", () => {
  it("uses an upwind threshold below the downwind one", () => {
    expect(DEFAULT_CLASSIFY_OPTIONS.upwindTwaMax).toBeLessThan(
      DEFAULT_CLASSIFY_OPTIONS.downwindTwaMin,
    );
  });
});

describe("carryManualLabels", () => {
  function twoLegPlan() {
    const points = syntheticEnriched(
      [
        { headingDeg: UPWIND, speedMps: 6, seconds: 150 },
        { headingDeg: DOWNWIND, speedMps: 9, seconds: 150 },
      ],
      { windFromDeg: 0 },
    );
    return { points, plan: buildSegmentPlan(points) };
  }

  it("keeps a rider's label on a rebuilt plan", () => {
    const { points, plan } = twoLegPlan();
    const second = plan.segments[plan.segments.length - 1];
    const edited = setSegmentLabel(plan, second.id, "free_downwind");

    // A rebuild with identical input produces the same boundaries, so the label must survive.
    const rebuilt = buildSegmentPlan(points);
    const carried = carryManualLabels(edited, rebuilt);
    const byRange = carried.segments.find((s) => s.startIdx === second.startIdx && s.endIdx === second.endIdx);
    expect(byRange?.manualLabel).toBe("free_downwind");
  });

  it("does not smear a label across a segment that only partly overlapped it", () => {
    const { points, plan } = twoLegPlan();
    const first = plan.segments[0];
    // Label only a handful of points at the very start, then present a rebuilt plan whose first
    // segment spans the whole leg (so the little label is a small minority).
    const labelled = labelRange(plan, points, first.startIdx, first.startIdx + 3, "excluded");
    const rebuilt = buildSegmentPlan(points);
    const carried = carryManualLabels(labelled, rebuilt);
    expect(carried.segments[0].manualLabel).toBeNull();
  });

  it("returns the new plan unchanged when nothing was labelled", () => {
    const { points, plan } = twoLegPlan();
    const rebuilt = buildSegmentPlan(points);
    const carried = carryManualLabels(plan, rebuilt);
    expect(carried.segments.every((s) => s.manualLabel == null)).toBe(true);
    expect(effectiveLabel(carried.segments[0])).toBe(effectiveLabel(rebuilt.segments[0]));
  });
});
