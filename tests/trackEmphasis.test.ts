import { describe, expect, it } from "vitest";
import { buildSegmentPlan } from "@/lib/classify";
import { downwindRuns } from "@/lib/summary";
import { buildTrackFeatures, resolveTrackEmphasis, type TrackFeature } from "@/lib/trackEmphasis";
import { syntheticEnriched } from "./helpers";

const UPWIND = 45;
const DOWNWIND = 135;

/**
 * A session with two downwind runs and a beat between them: a long one and a short one. That is the
 * shape of every real session, and the shape whose emphasis rules went wrong — the longest run's
 * passive mark used to outlive a selection of the shorter one.
 */
function scenario() {
  const points = syntheticEnriched(
    [
      { headingDeg: DOWNWIND, speedMps: 9, seconds: 120 }, // long run
      { headingDeg: UPWIND, speedMps: 6, seconds: 90 }, // beat between them
      { headingDeg: DOWNWIND, speedMps: 9, seconds: 40 }, // short run
    ],
    { windFromDeg: 0 },
  );
  const plan = buildSegmentPlan(points);
  const runs = downwindRuns(plan.segments, points);
  const features = buildTrackFeatures(points, plan);
  return { points, plan, runs, features };
}

const ids = (feats: readonly TrackFeature[], pick: (p: TrackFeature["properties"]) => boolean) =>
  feats.filter((f) => pick(f.properties)).map((f) => f.properties.id);

describe("buildTrackFeatures", () => {
  it("draws one usable solid line per segment", () => {
    const { plan, features } = scenario();
    expect(features.map((f) => f.properties.id)).toEqual(plan.segments.map((s) => s.id));
    expect(features.every((f) => f.geometry.type === "LineString")).toBe(true);
    expect(features.every((f) => f.geometry.coordinates.length >= 2)).toBe(true);
    expect(
      features.every((f) => f.geometry.coordinates.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))),
    ).toBe(true);
    expect(features.every((f) => /^#[0-9a-f]{6}$/i.test(f.properties.color))).toBe(true);
  });

  it("starts with nothing emphasised", () => {
    const { features } = scenario();
    expect(ids(features, (p) => p.selected || p.highlight || p.focus || p.dim)).toEqual([]);
  });
});

describe("resolveTrackEmphasis", () => {
  /** The two runs, with the longest identified. */
  function runs() {
    const s = scenario();
    const [first, second] = s.runs;
    const longest = first.segment.features.distanceM >= second.segment.features.distanceM ? first : second;
    const other = longest === first ? second : first;
    return { ...s, longest, other };
  }

  it("finds two runs so the rule is actually under test", () => {
    const r = runs();
    expect(r.runs).toHaveLength(2);
    expect(r.longest.segment.features.distanceM).toBeGreaterThan(r.other.segment.features.distanceM);
  });

  it("marks only the longest run passively while nothing is selected", () => {
    const { features, longest } = runs();
    const feats = resolveTrackEmphasis(features, null, longest.segment.id);
    expect(ids(feats, (p) => p.highlight)).toEqual([longest.segment.id]);
    expect(ids(feats, (p) => p.focus)).toEqual([longest.segment.id]);
    // A passive mark must not grey the map back: repainting the whole track on load is not what
    // "longest" is worth.
    expect(ids(feats, (p) => p.dim)).toEqual([]);
  });

  it("drops the passive mark the moment the rider selects anything else", () => {
    // The bug a rider reported: clicking a shorter run left the longest one in full colour with its
    // halo, so two stretches looked selected and the map answered the wrong question.
    const { features, longest, other } = runs();
    const feats = resolveTrackEmphasis(features, other.segment.id, longest.segment.id);
    expect(ids(feats, (p) => p.highlight)).toEqual([]);
    expect(ids(feats, (p) => p.focus)).toEqual([other.segment.id]);
    expect(ids(feats, (p) => p.selected)).toEqual([other.segment.id]);
    expect(ids(feats, (p) => p.dim)).toContain(longest.segment.id);
  });

  it("keeps exactly one emphasised stretch whenever something is selected", () => {
    const { features, plan, longest, other } = runs();
    for (const id of [longest.segment.id, other.segment.id, plan.segments[1].id]) {
      const feats = resolveTrackEmphasis(features, id, longest.segment.id);
      expect(ids(feats, (p) => p.focus)).toEqual([id]);
      expect(ids(feats, (p) => p.highlight)).toEqual([]);
      // Every other stretch steps back, including a block that is not a run at all.
      expect(ids(feats, (p) => p.dim)).toHaveLength(features.length - 1);
    }
  });

  it("selecting the longest run is the same as any other selection", () => {
    const { features, longest } = runs();
    const feats = resolveTrackEmphasis(features, longest.segment.id, longest.segment.id);
    expect(ids(feats, (p) => p.highlight)).toEqual([]);
    expect(ids(feats, (p) => p.focus)).toEqual([longest.segment.id]);
  });

  it("does not grey the map when there is nothing to mark", () => {
    const { features } = runs();
    const feats = resolveTrackEmphasis(features, null, null);
    expect(ids(feats, (p) => p.dim || p.focus || p.selected || p.highlight)).toEqual([]);
  });

  it("leaves the input features untouched", () => {
    const { features, longest, other } = runs();
    resolveTrackEmphasis(features, other.segment.id, longest.segment.id);
    expect(features.every((f) => !f.properties.selected && !f.properties.dim && !f.properties.focus)).toBe(
      true,
    );
  });
});
