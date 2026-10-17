/**
 * Presentation helpers shared by every view.
 *
 * These are deliberately pure and dependency-free (no React): the map, the charts, the timeline
 * and the session list all read the same label text and the same colours, so a downwind run looks
 * identical wherever it is drawn.
 *
 * A note on the two downwind labels. Their identifiers (`free_downwind`, `powered_downwind`) are
 * persisted inside saved sessions, so they are left alone; only what the rider *reads* is named
 * here. In parawing terms the rider sails upwind with the wing flying, then packs the wing down on
 * a wave and rides swell: a parawing cannot hold a dead run while it is flying, so a deep course
 * means the wing is stowed. `free_downwind` is therefore shown as plain **Downwind** — it is the
 * run the rider came for, and the only thing counted as downwind distance or time — while
 * `powered_downwind` is a **Powered reach**: the wing still flying with the course falling away
 * from the wind, which is not a downwind run at all.
 */

import { providerById } from "./wind/providers";
import { effectiveLabel, isRunSized } from "./classify";
import type { Segment, SegmentLabel, WindModel } from "./types";

/* --------------------------------------------------------------------- wind */

/**
 * One-line description of where the wind came from, e.g. `MET Norway Frost · Sola`.
 * Shown in the session list and the dashboard header so the provenance is never hidden.
 */
export function describeWindSource(wind: WindModel): string {
  if (wind.kind === "none") return "No wind";
  if (wind.kind === "manual") return "Manual wind";
  const provider = providerById(wind.kind);
  const name = provider?.name ?? wind.kind;
  const station = wind.station?.name;
  return station ? `${name} · ${station}` : name;
}

/** Short badge for a wind quality, used next to the numbers. */
export const WIND_QUALITY_TEXT = {
  measured: "measured",
  modelled: "modelled",
  manual: "entered by you",
} as const;

/**
 * One line saying what the VMG columns were computed against.
 *
 * VMG is only as good as the wind it is measured against, and "VMG ↑" printed with no provenance
 * invites the reader to trust a modelled reanalysis as if it were an anemometer on the beach. So
 * the tables state the source, whether it was measured or modelled, how many observations went in,
 * and how much of the track they covered — and say plainly when there was no direction to work
 * with, because that is the case where the columns are blank rather than zero.
 */
export function describeVmgBasis(
  wind: WindModel,
  summary: { observationCount: number; coverage: number; meanDirFromDeg: number | null },
): string {
  if (wind.kind === "none") {
    return "Upwind VMG needs wind. Add a wind source and the column fills in — nothing is guessed in the meantime.";
  }
  if (summary.meanDirFromDeg == null) {
    return `The wind source (${describeWindSource(wind)}) reported no direction, so true wind angle and upwind VMG cannot be derived. The column stays blank rather than showing a zero.`;
  }
  const quality =
    wind.kind === "manual" ? "manual" : (providerById(wind.kind)?.quality ?? "modelled");
  const observations =
    summary.observationCount > 0 ? `${summary.observationCount} observations` : "no observations";
  return `Upwind VMG measured against ${describeWindSource(wind)} — ${WIND_QUALITY_TEXT[quality]}, ${observations} over ${Math.round(summary.coverage * 100)}% of the track.`;
}

/* ------------------------------------------------------------------ segment */

export const SEGMENT_LABEL_TEXT: Record<SegmentLabel, string> = {
  upwind: "Upwind",
  reaching: "Reaching",
  idle: "Idle",
  powered_downwind: "Powered reach",
  free_downwind: "Downwind",
  unclassified: "Unclassified",
  excluded: "Excluded",
};

/** One-line explanation for the label menu. */
export const SEGMENT_LABEL_HINT: Record<SegmentLabel, string> = {
  upwind: "Working towards the wind, parawing flying.",
  reaching: "Beam or broad reach, neither clearly up nor down.",
  idle: "Not sailing: drifting, pumping out, or stopped.",
  powered_downwind:
    "Wing still flying and carrying you down from the wind. A broad reach, not a downwind run.",
  free_downwind:
    "Parawing packed down on a wave, riding swell. This is the downwind run, and the only thing counted as one.",
  unclassified: "There was not enough data (usually wind) to tell.",
  excluded: "Ignore this part of the track in the statistics.",
};

/**
 * Segment colours.
 *
 * Signal green is ordinary sailing (upwind), Familiar Tone pink is the downwind run itself — the
 * wing packed and the rider on swell — and Soft Origin is a powered reach, close enough to the
 * downwind family to belong in the legend but never counted with it. Everything the app is unsure
 * about is neutral grey, so the two vivid hues always mean "the rider was actually riding". The
 * values are darkened versions of the accent tokens in `globals.css` because they are drawn as map
 * lines on a pale basemap, where a light accent would disappear.
 */
export const SEGMENT_COLORS: Record<SegmentLabel, string> = {
  upwind: "#14a45c", // Signal green
  reaching: "#0f7c7c", // deep teal: same family as upwind, plainly not upwind
  idle: "#b0ac9f", // quiet: not sailing
  powered_downwind: "#e0763a", // Soft Origin (wing still flying, falling off)
  free_downwind: "#dc4b8e", // Familiar Tone (wing packed, riding swell)
  unclassified: "#8e8a7e", // unknown
  excluded: "#d2cec3", // ignored entirely
};

export function segmentColor(label: SegmentLabel): string {
  return SEGMENT_COLORS[label] ?? SEGMENT_COLORS.unclassified;
}

/** Legend order: what a rider wants to see first is the downwind they came for. */export const LEGEND_ORDER: SegmentLabel[] = [
  "free_downwind",
  "powered_downwind",
  "upwind",
  "reaching",
  "idle",
  "unclassified",
  "excluded",
];

/** True when a segment's label came from the classifier rather than the rider. */
export function isEstimated(segment: Segment): boolean {
  return segment.manualLabel == null;
}

export function segmentLabelOf(segment: Segment): SegmentLabel {
  return effectiveLabel(segment);
}

/** Compact "Free downwind · 1.2 km · 4:30" style title for a segment. */
export function segmentTitle(segment: Segment, formatDistance: (m: number) => string): string {
  const label = SEGMENT_LABEL_TEXT[effectiveLabel(segment)];
  return `${label} · ${formatDistance(segment.features.distanceM)}`;
}

/* --------------------------------------------------------------------- runs */

/**
 * One contiguous stretch of track worth listing on its own: a downwind run, or an upwind beat.
 * The map badge, the table row and the statistics all read the same object.
 */
export interface TrackRun {
  /** 1-based number, assigned chronologically so the map badge and the table row agree. */
  n: number;
  segment: Segment;
  label: SegmentLabel;
  /** epoch ms of the first and last point in the run */
  startT: number;
  endT: number;
}

/** A downwind run as listed in the DW table and numbered on the map. */
export type DownwindRun = TrackRun;

/**
 * True only for a real downwind run: the wing packed, the rider on wave energy.
 *
 * A powered reach is deliberately excluded. It is a stretch the rider was still flying through,
 * having borne away only a little past the beam, and counting it as downwind would inflate the one
 * number this whole app exists to answer — how far did I go downwind.
 */
export function isDownwindRunLabel(label: SegmentLabel): boolean {
  return label === "free_downwind";
}

/**
 * Every segment matching `match`, numbered in chronological order.
 *
 * Both confirmed stretches and the classifier's unconfirmed guesses are included — the map labels
 * them all as candidates — so the numbering is stable whether or not the rider has reviewed them
 * yet. Excluded segments never appear: exclusion wins over everything, and neither does a stretch
 * too short to be a run (`isRunSized`), so the table, the map badges and the totals all agree.
 */
export function segmentRuns(
  segments: readonly Segment[],
  points: readonly { t: number }[],
  match: (label: SegmentLabel) => boolean,
): TrackRun[] {
  const runs: TrackRun[] = [];
  for (const segment of [...segments].sort((a, b) => a.startIdx - b.startIdx)) {
    const label = effectiveLabel(segment);
    if (!match(label)) continue;
    if (!isRunSized(segment)) continue;
    const start = points[segment.startIdx];
    const end = points[segment.endIdx];
    if (!start || !end) continue;
    runs.push({
      n: runs.length + 1,
      segment,
      label,
      startT: start.t,
      endT: end.t,
    });
  }
  return runs;
}

/** Every downwind run of a plan, numbered in chronological order. */
export function downwindRuns(
  segments: readonly Segment[],
  points: readonly { t: number }[],
): DownwindRun[] {
  return segmentRuns(segments, points, isDownwindRunLabel);
}

/** Every upwind beat of a plan, numbered in chronological order. */
export function upwindRuns(
  segments: readonly Segment[],
  points: readonly { t: number }[],
): TrackRun[] {
  return segmentRuns(segments, points, (label) => label === "upwind");
}
