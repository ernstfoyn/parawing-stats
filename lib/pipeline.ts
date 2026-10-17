/**
 * The analysis pipeline.
 *
 * One pure function turns (cleaned track, wind samples, wind model, optional saved segment plan)
 * into everything the UI renders. Because it is pure and cheap, the dashboard can re-run it on
 * every manual segment edit and every wind-source change without re-parsing the file.
 */

import { buildSegmentPlan, downwindStats, pointLabels, recomputePlanFeatures, type DownwindBreakdown } from "./classify";
import { computeSessionMetrics, directionStats } from "./metrics";
import { alignWind, summariseAligned, type WindSummary } from "./wind/align";
import type {
  DirectionStats,
  EnrichedPoint,
  SegmentLabel,
  SegmentPlan,
  SessionMetrics,
  TrackPoint,
  WindModel,
  WindSample,
} from "./types";

export interface AnalysisInput {
  points: readonly TrackPoint[];
  windSamples: readonly WindSample[];
  windModel: WindModel;
  /** A previously saved (possibly hand-edited) plan. Omit to classify from scratch. */
  plan?: SegmentPlan | null;
  /** Force re-classification even when a plan is supplied. */
  rebuildSegments?: boolean;
}

export interface Analysis {
  points: EnrichedPoint[];
  plan: SegmentPlan;
  labels: SegmentLabel[];
  metrics: SessionMetrics;
  upwind: DirectionStats;
  downwind: DirectionStats;
  wind: WindSummary;
  dw: DownwindBreakdown;
}

export function analyse(input: AnalysisInput): Analysis {
  const { points, windSamples, windModel } = input;
  const range =
    points.length > 0 ? { start: points[0].t, end: points[points.length - 1].t } : undefined;

  const enriched = alignWind(points, windSamples, windModel, range);

  let plan: SegmentPlan;
  if (input.plan && !input.rebuildSegments && planCoversPointCount(input.plan, enriched.length)) {
    // Re-run feature extraction so the stats reflect the current wind data, but keep the rider's
    // manual corrections exactly as they were saved.
    plan = recomputePlanFeatures(input.plan, enriched);
  } else {
    plan = buildSegmentPlan(enriched);
  }

  return {
    points: enriched,
    plan,
    labels: pointLabels(enriched, plan),
    metrics: computeSessionMetrics(enriched),
    upwind: directionStats(enriched, "upwind"),
    downwind: directionStats(enriched, "downwind"),
    wind: summariseAligned(enriched),
    dw: downwindStats(plan),
  };
}

function planCoversPointCount(plan: SegmentPlan, count: number): boolean {
  if (count === 0) return plan.segments.length === 0;
  if (plan.segments.length === 0) return false;
  const first = plan.segments[0];
  const last = plan.segments[plan.segments.length - 1];
  return first.startIdx === 0 && last.endIdx === count - 1;
}
