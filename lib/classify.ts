/**
 * Downwind segment detection.
 *
 * ## What this can and cannot know
 *
 * GPS and a weather station can tell us that a rider was moving fast, mostly away from the wind.
 * They cannot tell us whether the parawing was still flying or packed away on a wave. So this
 * module produces *candidates* with a confidence and a plain-language explanation, never a verdict.
 * The rider confirms, relabels, splits and merges; those corrections are stored and become the
 * ground truth for the session.
 *
 * ## Design
 *
 * `buildSegmentPlan` tiles the whole track (every point belongs to exactly one segment), which
 * makes editing lossless and makes statistics trivial to recompute after an edit. Every segment
 * keeps the features and the reasons behind its automatic guess so a future version can be trained
 * on the stored manual corrections. Keep the heuristics inside `scoreDownwindKind` and bump
 * `ENGINE_VERSION` when the rules change.
 */

import { clamp, circularMeanDeg, circularSpread, percentile } from "./geo";
import { intervalAt } from "./metrics";
import type {
  EnrichedPoint,
  Segment,
  SegmentFeatures,
  SegmentLabel,
  SegmentPlan,
  SegmentStats,
} from "./types";

export const ENGINE_VERSION = "dw-classifier-v1";

export interface ClassifyOptions {
  /** TWA at or above this is treated as downwind */
  downwindTwaMin: number;
  /** TWA at or below this is treated as upwind */
  upwindTwaMax: number;
  /** below this speed (m/s) the rider is not really sailing */
  minSpeedMps: number;
  /** runs shorter than this are absorbed into a neighbour so segments stay meaningful */
  minRunS: number;
}

export const DEFAULT_CLASSIFY_OPTIONS: ClassifyOptions = {
  downwindTwaMin: 110,
  upwindTwaMax: 70,
  minSpeedMps: 2,
  minRunS: 12,
};

/**
 * Where a downwind stretch stops being a powered reach and becomes a downwind run: within 55° of
 * straight downwind, i.e. TWA at or beyond 125°. This is the rider's own rule — a parawing cannot
 * hold a course that deep with the wing flying, so the wing must have been packed. See
 * `scoreDownwindKind`, which is the only thing that should use it.
 */
export const RUN_TWA_MIN = 125;

/**
 * A stretch has to last and cover ground before it is worth calling a run.
 *
 * Below this it is a gybe, a wobble or a slide, not a downwind run, and listing it would pad the
 * table with fragments and inflate the count. The same floor is applied to upwind stretches so a
 * table always means the same thing by "a run".
 */
export const RUN_MIN_DURATION_S = 30;
export const RUN_MIN_DISTANCE_M = 100;

/** True when a stretch is long enough to count as a run in the tables and the totals. */
export function isRunSized(segment: Segment): boolean {
  return (
    segment.features.durationS >= RUN_MIN_DURATION_S &&
    segment.features.distanceM >= RUN_MIN_DISTANCE_M
  );
}

/** Internal per-point state. `unclassified` means "we cannot tell" (usually missing wind). */
type PointState = "upwind" | "reaching" | "downwind" | "idle" | "unclassified";

const STATE_TO_LABEL: Record<PointState, SegmentLabel> = {
  upwind: "upwind",
  reaching: "reaching",
  downwind: "powered_downwind", // refined into downwind / powered reach by scoreDownwindKind
  idle: "idle",
  unclassified: "unclassified",
};

/**
 * True when a point carries a *measured* speed low enough to say the rider was not sailing.
 *
 * Exported because it is the whole of a rule that was once broken and is otherwise invisible: a
 * dropout has no speed and no course, and the old `pointState` called `!p.moving` idle — which every
 * gap point satisfies — so stretches the watch had not recorded were reported as the rider lying
 * still. On a real Rygge session 65 gaps, the longest 83 s, made up 20:44 of a 43:24 "idle" total,
 * while only 8:27 of it was measured below 0.5 m/s. The mistake does not show up in the segment
 * output either, because a single dropped fix is absorbed into its neighbour.
 */
export function isMeasuredIdle(
  p: EnrichedPoint,
  opts: ClassifyOptions = DEFAULT_CLASSIFY_OPTIONS,
): boolean {
  if (p.gap) return false;
  if (p.speed == null) return false;
  return !p.moving || p.speed < opts.minSpeedMps;
}

function pointState(p: EnrichedPoint, opts: ClassifyOptions): PointState {
  // A dropout is not a measurement, so it cannot be idle; nor can a point whose speed could not be
  // derived — both answer "unmeasured", which is what `unclassified` means here.
  if (p.gap || p.speed == null) return "unclassified";
  if (isMeasuredIdle(p, opts)) return "idle";
  if (p.twa == null) return "unclassified";
  if (p.twa >= opts.downwindTwaMin) return "downwind";
  if (p.twa <= opts.upwindTwaMax) return "upwind";
  return "reaching";
}

interface Run {
  start: number;
  end: number;
  state: PointState;
}

function runDurationS(run: Run, points: readonly EnrichedPoint[]): number {
  return (points[run.end].t - points[run.start].t) / 1000;
}

function buildRuns(points: readonly EnrichedPoint[], opts: ClassifyOptions): Run[] {
  const runs: Run[] = [];
  if (points.length === 0) return runs;
  let current: Run = { start: 0, end: 0, state: pointState(points[0], opts) };
  for (let i = 1; i < points.length; i++) {
    const s = pointState(points[i], opts);
    if (s === current.state) {
      current.end = i;
    } else {
      runs.push(current);
      current = { start: i, end: i, state: s };
    }
  }
  runs.push(current);
  return runs;
}

/**
 * Absorb runs too short to be a real segment. A short run is swallowed by a neighbour that already
 * has the same state if possible, otherwise by the longer neighbour. This keeps one slow sample
 * from chopping a downwind run in half while still refusing to merge two genuine runs across an
 * upwind leg.
 */
function smoothRuns(
  runs: readonly Run[],
  points: readonly EnrichedPoint[],
  opts: ClassifyOptions,
): Run[] {
  const out = runs.map((r) => ({ ...r }));
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let i = 0; i < out.length; i++) {
      const run = out[i];
      if (out.length === 1 || runDurationS(run, points) >= opts.minRunS) continue;

      const prevRun = i > 0 ? out[i - 1] : null;
      const nextRun = i + 1 < out.length ? out[i + 1] : null;

      if (prevRun && prevRun.state === run.state) {
        prevRun.end = run.end;
      } else if (nextRun && nextRun.state === run.state) {
        nextRun.start = run.start;
      } else {
        const prevLen = prevRun ? runDurationS(prevRun, points) : -1;
        const nextLen = nextRun ? runDurationS(nextRun, points) : -1;
        if (prevRun && prevLen >= nextLen) prevRun.end = run.end;
        else if (nextRun) nextRun.start = run.start;
        else continue;
      }
      out.splice(i, 1);
      i--;
      changed = true;
    }
    if (!changed) break;
  }

  // Neighbours can end up sharing a state after absorption; merge those too.
  const merged: Run[] = [];
  for (const run of out) {
    const last = merged[merged.length - 1];
    if (last && last.state === run.state) last.end = run.end;
    else merged.push({ ...run });
  }
  return merged;
}

/** Time-weighted features for one segment. */
export function segmentFeatures(
  points: readonly EnrichedPoint[],
  startIdx: number,
  endIdx: number,
): SegmentFeatures {
  const start = Math.max(0, startIdx);
  const end = Math.min(points.length - 1, endIdx);
  const slice = points.slice(start, end + 1);

  let durationS = 0;
  let distanceM = 0;
  let movingDt = 0;
  let speedWeighted = 0;
  let speedWeight = 0;
  let maxSpeed: number | null = null;
  let twaWeighted = 0;
  let twaWeight = 0;
  let deadRun = 0;
  let gapS = 0;
  let vmgWeighted = 0;
  let vmgWeight = 0;

  const headings: number[] = [];
  const winds: number[] = [];

  for (const p of slice) {
    if (p.cog != null) headings.push(p.cog);
    if (p.windSpeedMps != null) winds.push(p.windSpeedMps);
  }

  // Intervals are attributed by the index of the sample that *ends* them, so a segment takes the
  // interval that arrives at its first point. Summing over any tiling of the track therefore
  // reproduces the track totals exactly, and splitting a segment keeps the sums exact instead of
  // quietly dropping the interval across the split.
  for (let i = Math.max(1, start); i <= end; i++) {
    const iv = intervalAt(points, i);
    if (!iv) continue;
    durationS += iv.dt;
    distanceM += iv.dd;
    if (iv.to.gap) gapS += iv.dt;
    if (iv.to.moving) movingDt += iv.dt;
    const speed = iv.mid((p) => (p.gap ? null : p.speed));
    if (speed != null) {
      speedWeighted += speed * iv.dt;
      speedWeight += iv.dt;
      if (maxSpeed == null || speed > maxSpeed) maxSpeed = speed;
    }
    const twa = iv.mid((p) => p.twa);
    if (twa != null) {
      twaWeighted += twa * iv.dt;
      twaWeight += iv.dt;
      if (twa >= 150) deadRun += iv.dt;
    }
    const vmg = iv.mid((p) => p.vmgDownMps);
    if (vmg != null) {
      vmgWeighted += vmg * iv.dt;
      vmgWeight += iv.dt;
    }
  }

  const avgSpeedMps =
    speedWeight > 0
      ? speedWeighted / speedWeight
      : durationS > 0
        ? distanceM / durationS
        : 0;

  return {
    durationS,
    distanceM,
    avgSpeedMps,
    maxSpeedMps: maxSpeed ?? 0,
    avgTwaDeg: twaWeight > 0 ? twaWeighted / twaWeight : Number.NaN,
    headingSpread: circularSpread(headings),
    avgVmgDownMps: vmgWeight > 0 ? vmgWeighted / vmgWeight : 0,
    deadRunFraction: durationS > 0 ? deadRun / durationS : 0,
    movingFraction: durationS > 0 ? movingDt / durationS : 0,
    gapS,
    avgWindSpeedMps: winds.length ? winds.reduce((a, b) => a + b, 0) / winds.length : null,
  };
}

/**
 * Guess whether a downwind stretch is a downwind run or a powered reach.
 *
 * The rule is the rider's own, not a heuristic invented here: **a parawing cannot hold a course
 * within 55° of straight downwind while it is still flying**, so a stretch that deep was ridden
 * with the wing packed down and the rider on wave energy. Anything in the downwind band that stays
 * shallower than that is a *powered reach* — the rider has borne away only a little from the beam
 * with the wing still up. Hence a course test, `TWA >= 125°`, which is what a rider means by
 * "downwind" and what makes a powered stretch look obviously different on the map.
 *
 * An earlier version of this function let speed relative to the session carry most of the weight
 * and treated depth as a weak corroborator. On a real Rygge session that labelled twenty
 * dead-run stretches as "powered" because they happened to be slower than the session's fastest
 * 10 %, which is backwards: for this rider, going deep is *why* the wing comes down.
 *
 * Speed still corroborates — a swell ride usually carries speed — but only in the confidence, and
 * never enough to move the boundary. Confidence is capped well below 1: GPS cannot see whether the
 * wing was packed, and the UI says so.
 */
export function scoreDownwindKind(
  features: SegmentFeatures,
  sessionRefSpeedMps: number | null,
  windCoverage: number,
): { label: SegmentLabel; confidence: number; reasons: string[] } {
  const reasons: string[] = [];

  const twa = Number.isFinite(features.avgTwaDeg) ? features.avgTwaDeg : null;
  const isRun = twa != null && twa >= RUN_TWA_MIN;
  const label: SegmentLabel = isRun ? "free_downwind" : "powered_downwind";

  const depth = clamp(features.deadRunFraction, 0, 1);

  if (twa == null) {
    reasons.push("No wind direction was available for part of this segment.");
  } else if (isRun) {
    const off = 180 - twa;
    reasons.push(
      `Ran within ${Math.round(off)}° of straight downwind (mean TWA ${Math.round(twa)}°) — too deep for a parawing to hold with the wing flying, so the wing was probably packed.`,
    );
  } else {
    reasons.push(
      `Bore away only ${Math.round(twa - 90)}° past the beam (mean TWA ${Math.round(twa)}°), short of a run — the wing was probably still carrying the rider.`,
    );
  }
  if (depth > 0.2) {
    reasons.push(
      `${Math.round(depth * 100)}% of the stretch was beyond 150°, i.e. dead downwind.`,
    );
  }

  const ref = sessionRefSpeedMps && sessionRefSpeedMps > 1 ? sessionRefSpeedMps : null;
  const speedRatio = ref ? features.avgSpeedMps / ref : null;
  if (speedRatio != null && ref) {
    reasons.push(
      `Average ${features.avgSpeedMps.toFixed(1)} m/s, ${Math.round(speedRatio * 100)}% of the session's reference downwind speed (${ref.toFixed(1)} m/s). Speed only corroborates the course.`,
    );
  }

  reasons.push(
    features.headingSpread < 0.2
      ? `Heading stayed steady (spread ${(features.headingSpread * 100).toFixed(0)}%).`
      : `Heading varied (spread ${(features.headingSpread * 100).toFixed(0)}%), consistent with carving or weaving.`,
  );

  if (features.avgWindSpeedMps != null) {
    reasons.push(
      `Wind at the station averaged ${features.avgWindSpeedMps.toFixed(1)} m/s during the run.`,
    );
  }

  // How far the call sits from the boundary, and how solid the supporting evidence is. A stretch
  // that clears 125° by a degree is honestly a coin flip; one at 155° is not.
  const margin = twa == null ? 0 : clamp(Math.abs(twa - RUN_TWA_MIN) / 25, 0, 1);
  const confidence = clamp(
    0.28 + 0.22 * margin + 0.15 * depth + 0.15 * clamp(windCoverage, 0, 1),
    0.3,
    0.8,
  );

  reasons.push(
    "Estimate only — GPS and wind cannot show whether the parawing was still flying. Confirm or change the label.",
  );

  return { label, confidence, reasons };
}

/** 90th percentile of moving speed: the reference for "is this run fast?" */
export function sessionReferenceSpeed(points: readonly EnrichedPoint[]): number | null {
  const speeds: number[] = [];
  for (const p of points) {
    if (p.moving && !p.gap && p.speed != null) speeds.push(p.speed);
  }
  return percentile(speeds, 90);
}

/** Build a complete, editable segment plan for a track. */
export function buildSegmentPlan(
  points: readonly EnrichedPoint[],
  options: Partial<ClassifyOptions> = {},
): SegmentPlan {
  const opts = { ...DEFAULT_CLASSIFY_OPTIONS, ...options };
  if (points.length === 0) return { segments: [], engineVersion: ENGINE_VERSION };

  const runs = smoothRuns(buildRuns(points, opts), points, opts);
  const refSpeed = sessionReferenceSpeed(points);

  let windPoints = 0;
  for (const p of points) if (p.twa != null) windPoints++;
  const windCoverage = windPoints / points.length;

  const segments: Segment[] = [];
  for (const run of runs) {
    if (run.end < run.start) continue;
    const features = segmentFeatures(points, run.start, run.end);
    let label = STATE_TO_LABEL[run.state];
    let confidence = 0.9;
    let reasons: string[] = [];

    if (run.state === "downwind") {
      const guess = scoreDownwindKind(features, refSpeed, windCoverage);
      label = guess.label;
      confidence = guess.confidence;
      reasons = guess.reasons;
    } else if (run.state === "idle") {
      confidence = 0.85;
      reasons = [`Average speed ${features.avgSpeedMps.toFixed(1)} m/s — below the sailing threshold.`];
    } else if (run.state === "unclassified") {
      confidence = 0.3;
      reasons = ["No wind direction available, so this part of the track cannot be classified."];
    } else {
      const twaText = Number.isFinite(features.avgTwaDeg)
        ? `Mean TWA ${Math.round(features.avgTwaDeg)}°`
        : "No wind data";
      confidence = run.state === "upwind" ? 0.9 : 0.7;
      reasons = [`${twaText} — ${run.state === "upwind" ? "sailing towards the wind" : "beam reach"}.`];
    }

    segments.push({
      id: `seg-${run.start}-${run.end}-${segments.length}`,
      startIdx: run.start,
      endIdx: run.end,
      auto: { label, confidence, reasons },
      manualLabel: null,
      features,
    });
  }

  return { segments, engineVersion: ENGINE_VERSION };
}

/** The label actually in force for a segment. */
export function effectiveLabel(s: Segment): SegmentLabel {
  return s.manualLabel ?? s.auto.label;
}

export function isDownwindLabel(label: SegmentLabel): boolean {
  return label === "powered_downwind" || label === "free_downwind";
}

/** Per-point effective labels, used to colour the map. */
export function pointLabels(
  points: readonly EnrichedPoint[],
  plan: SegmentPlan,
): SegmentLabel[] {
  const labels: SegmentLabel[] = new Array(points.length).fill("unclassified");
  for (const seg of plan.segments) {
    const label = effectiveLabel(seg);
    const from = Math.max(0, seg.startIdx);
    const to = Math.min(points.length - 1, seg.endIdx);
    for (let i = from; i <= to; i++) labels[i] = label;
  }
  return labels;
}

export function segmentById(plan: SegmentPlan, id: string): Segment | undefined {
  return plan.segments.find((s) => s.id === id);
}

export function segmentAt(plan: SegmentPlan, idx: number): Segment | null {
  for (const s of plan.segments) {
    if (idx >= s.startIdx && idx <= s.endIdx) return s;
  }
  return null;
}

/* ------------------------------------------------------------------ editing */

const MAX_SEGMENTS = 5000;

function tidy(segments: readonly Segment[]): Segment[] {
  const sorted = segments
    .filter((s) => s.endIdx >= s.startIdx)
    .sort((a, b) => a.startIdx - b.startIdx)
    .slice(0, MAX_SEGMENTS);
  const seen = new Set<string>();
  return sorted.map((s, i) => {
    let id = s.id && !seen.has(s.id) ? s.id : `seg-${s.startIdx}-${s.endIdx}-${i}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    return id === s.id ? s : { ...s, id };
  });
}

/** Recompute every segment's features after the underlying track or wind changes. */
export function recomputePlanFeatures(
  plan: SegmentPlan,
  points: readonly EnrichedPoint[],
): SegmentPlan {
  return {
    ...plan,
    segments: plan.segments.map((s) => ({
      ...s,
      features: segmentFeatures(points, s.startIdx, s.endIdx),
    })),
  };
}

/** Split a segment at an interior index. */
export function splitSegment(
  plan: SegmentPlan,
  points: readonly EnrichedPoint[],
  id: string,
  atIdx: number,
): SegmentPlan {
  const idx = plan.segments.findIndex((s) => s.id === id);
  if (idx < 0) return plan;
  const seg = plan.segments[idx];
  if (atIdx <= seg.startIdx || atIdx > seg.endIdx) return plan;
  const left: Segment = { ...seg, endIdx: atIdx - 1 };
  const right: Segment = {
    ...seg,
    id: `${seg.id}-b`,
    startIdx: atIdx,
    manualLabel: seg.manualLabel,
  };
  const segments = [...plan.segments];
  segments.splice(idx, 1, left, right);
  return recomputePlanFeatures({ ...plan, segments: tidy(segments) }, points);
}

/**
 * Merge a segment with its previous or next neighbour. The result keeps a manual label only when
 * both halves already agreed on one; otherwise it falls back to the automatic guess, which is the
 * only label that is certainly true of the whole range.
 */
export function mergeSegments(
  plan: SegmentPlan,
  points: readonly EnrichedPoint[],
  id: string,
  direction: "prev" | "next",
): SegmentPlan {
  const idx = plan.segments.findIndex((s) => s.id === id);
  if (idx < 0) return plan;
  const otherIdx = direction === "prev" ? idx - 1 : idx + 1;
  if (otherIdx < 0 || otherIdx >= plan.segments.length) return plan;
  const lo = plan.segments[Math.min(idx, otherIdx)];
  const hi = plan.segments[Math.max(idx, otherIdx)];
  const sameLabel = effectiveLabel(lo) === effectiveLabel(hi);
  const merged: Segment = {
    id: lo.id,
    startIdx: lo.startIdx,
    endIdx: hi.endIdx,
    auto: lo.auto,
    manualLabel: sameLabel ? (lo.manualLabel ?? hi.manualLabel) : null,
    features: lo.features,
  };
  const segments = [...plan.segments];
  segments.splice(Math.min(idx, otherIdx), 2, merged);
  return recomputePlanFeatures({ ...plan, segments: tidy(segments) }, points);
}

/** Set (or clear, with `null`) the manual label of one segment. */
export function setSegmentLabel(
  plan: SegmentPlan,
  id: string,
  label: SegmentLabel | null,
): SegmentPlan {
  return {
    ...plan,
    segments: plan.segments.map((s) => (s.id === id ? { ...s, manualLabel: label } : s)),
  };
}

/** Throw away every manual correction and return to the automatic plan. */
export function resetToAuto(plan: SegmentPlan): SegmentPlan {
  return { ...plan, segments: plan.segments.map((s) => ({ ...s, manualLabel: null })) };
}

/**
 * Re-apply a rider's manual labels to a freshly classified plan.
 *
 * Wind data can be added, replaced or removed after the rider has already confirmed some segments.
 * Rebuilding the automatic plan is the honest thing to do (the old guesses were made with different
 * wind), but the rider's decisions must survive it. A new segment adopts a manual label only when a
 * clear majority of its points carried that label before, so edits are never smeared across a
 * boundary the classifier has since moved.
 */
export function carryManualLabels(previous: SegmentPlan, next: SegmentPlan): SegmentPlan {
  if (previous.segments.length === 0) return next;
  const manual = new Map<number, SegmentLabel>();
  for (const s of previous.segments) {
    if (s.manualLabel == null) continue;
    for (let i = Math.max(0, s.startIdx); i <= s.endIdx; i++) manual.set(i, s.manualLabel);
  }
  if (manual.size === 0) return next;

  return {
    ...next,
    segments: next.segments.map((seg) => {
      const counts = new Map<SegmentLabel, number>();
      for (let i = seg.startIdx; i <= seg.endIdx; i++) {
        const label = manual.get(i);
        if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      if (counts.size === 0) return seg;
      let best: SegmentLabel | null = null;
      let bestCount = 0;
      for (const [label, n] of counts) {
        if (n > bestCount) {
          best = label;
          bestCount = n;
        }
      }
      const span = seg.endIdx - seg.startIdx + 1;
      return best != null && bestCount * 2 >= span ? { ...seg, manualLabel: best } : seg;
    }),
  };
}

/**
 * Label an index range. This is the workhorse behind "select part of the track and mark it as free
 * downwind surfing": the tiling is split at both ends and everything between is labelled, which is
 * effectively split + merge + relabel in one atomic operation.
 */
export function labelRange(
  plan: SegmentPlan,
  points: readonly EnrichedPoint[],
  startIdx: number,
  endIdx: number,
  label: SegmentLabel | null,
): SegmentPlan {
  if (points.length === 0) return plan;
  const start = Math.max(0, Math.min(startIdx, endIdx, points.length - 1));
  const end = Math.max(0, Math.min(Math.max(startIdx, endIdx), points.length - 1));
  if (end < start) return plan;

  let segments = [...plan.segments];

  // Split the tiling at both boundary indices.
  for (const boundary of [start, end + 1]) {
    const idx = segments.findIndex((s) => boundary > s.startIdx && boundary <= s.endIdx);
    if (idx >= 0) {
      const seg = segments[idx];
      segments.splice(
        idx,
        1,
        { ...seg, endIdx: boundary - 1 },
        { ...seg, id: `${seg.id}-b`, startIdx: boundary, manualLabel: seg.manualLabel },
      );
    }
  }

  const inRange = segments.filter((s) => s.startIdx >= start && s.endIdx <= end);
  if (label != null && inRange.length > 1) {
    const first = inRange[0];
    const last = inRange[inRange.length - 1];
    const merged: Segment = {
      id: first.id,
      startIdx: first.startIdx,
      endIdx: last.endIdx,
      auto: first.auto,
      manualLabel: label,
      features: first.features,
    };
    segments = [...segments.filter((s) => s.startIdx < start || s.endIdx > end), merged];
  } else {
    segments = segments.map((s) =>
      s.startIdx >= start && s.endIdx <= end ? { ...s, manualLabel: label } : s,
    );
  }

  return recomputePlanFeatures({ ...plan, segments: tidy(segments) }, points);
}

/** True when the plan covers the whole track with contiguous, non-overlapping segments. */
export function planCoversTrack(plan: SegmentPlan, pointCount: number): boolean {
  if (pointCount === 0) return plan.segments.length === 0;
  let expected = 0;
  for (const s of plan.segments) {
    if (s.startIdx !== expected) return false;
    if (s.endIdx < s.startIdx) return false;
    expected = s.endIdx + 1;
  }
  return expected === pointCount;
}

/* -------------------------------------------------------------------- stats */

/** The two kinds of downwind stretch, reported separately and never added together. */
export interface DownwindBreakdown {
  /**
   * The downwind runs: parawing packed, riding swell. This is the answer to "how far did I go
   * downwind", and the only thing counted as downwind distance or time.
   */
  downwind: SegmentStats;
  /**
   * Stretches with the wing still flying and the course falling away from the wind. A broad reach
   * rather than a run, so it is deliberately kept out of the downwind totals: a parawing cannot
   * hold a dead run under power, which means a powered stretch is never a downwind one.
   */
  poweredReach: SegmentStats;
}

/**
 * Aggregate downwind statistics, split into the runs the rider came for and the powered reaches
 * that merely look like them from a distance.
 *
 * Both confirmed and classifier-guessed segments are included, so the numbers react the moment the
 * rider relabels a stretch; the confidence of each guess is shown wherever it is used.
 */
export function downwindStats(plan: SegmentPlan): DownwindBreakdown {
  const downwind: Segment[] = [];
  const poweredReach: Segment[] = [];
  for (const s of plan.segments) {
    if (!isRunSized(s)) continue;
    const label = effectiveLabel(s);
    if (label === "free_downwind") downwind.push(s);
    else if (label === "powered_downwind") poweredReach.push(s);
  }
  return {
    downwind: statsFor(downwind),
    poweredReach: statsFor(poweredReach),
  };
}

function statsFor(segments: readonly Segment[]): SegmentStats {
  if (segments.length === 0) {
    return {
      count: 0,
      distanceM: 0,
      durationS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      avgVmgDownMps: null,
      longest: null,
    };
  }

  let distanceM = 0;
  let durationS = 0;
  let maxSpeedMps = 0;
  let longest: SegmentStats["longest"] = null;
  let vmgWeighted = 0;
  let vmgWeight = 0;

  for (const s of segments) {
    const f = s.features;
    distanceM += f.distanceM;
    durationS += f.durationS;
    if (f.maxSpeedMps > maxSpeedMps) maxSpeedMps = f.maxSpeedMps;
    if (f.durationS > 0) {
      vmgWeighted += f.avgVmgDownMps * f.durationS;
      vmgWeight += f.durationS;
    }
    if (!longest || f.distanceM > longest.distanceM) {
      longest = {
        id: s.id,
        startIdx: s.startIdx,
        endIdx: s.endIdx,
        distanceM: f.distanceM,
        durationS: f.durationS,
        avgSpeedMps: f.avgSpeedMps,
        maxSpeedMps: f.maxSpeedMps,
      };
    }
  }

  return {
    count: segments.length,
    distanceM,
    durationS,
    avgSpeedMps: durationS > 0 ? distanceM / durationS : 0,
    maxSpeedMps,
    avgVmgDownMps: vmgWeight > 0 ? vmgWeighted / vmgWeight : null,
    longest,
  };
}

/** Mean heading of the session's downwind running, handy for map labels. */
export function meanDownwindHeading(points: readonly EnrichedPoint[]): number | null {
  const headings = points
    .filter((p) => p.twa != null && p.twa >= 130 && p.moving)
    .map((p) => p.cog)
    .filter((c): c is number => c != null);
  return circularMeanDeg(headings);
}
