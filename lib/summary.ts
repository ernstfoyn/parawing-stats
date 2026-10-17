/**
 * Presentation helpers shared by every view.
 *
 * These are deliberately pure and dependency-free (no React): the map, the charts, the timeline
 * and the session list all read the same label text and the same colours, so a "free downwind"
 * run looks identical wherever it is drawn.
 */

import { providerById } from "./wind/providers";
import { effectiveLabel } from "./classify";
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

/* ------------------------------------------------------------------ segment */

export const SEGMENT_LABEL_TEXT: Record<SegmentLabel, string> = {
  upwind: "Upwind",
  reaching: "Reaching",
  idle: "Idle",
  powered_downwind: "Powered downwind",
  free_downwind: "Free downwind",
  unclassified: "Unclassified",
  excluded: "Excluded",
};

/** One-line explanation for the label menu. */
export const SEGMENT_LABEL_HINT: Record<SegmentLabel, string> = {
  upwind: "Working towards the wind, parawing flying.",
  reaching: "Beam or broad reach, neither clearly up nor down.",
  idle: "Not sailing: drifting, pumping out, or stopped.",
  powered_downwind: "Sailing downwind with the parawing still flying.",
  free_downwind: "Downwind run with the parawing packed — riding swell.",
  unclassified: "There was not enough data (usually wind) to tell.",
  excluded: "Ignore this part of the track in the statistics.",
};

/**
 * Segment colours.
 *
 * Signal green is ordinary sailing (upwind), the warm Soft Origin is downwind with the parawing
 * still flying, and Familiar Tone pink is the free/packed run. Everything the app is unsure about
 * is neutral grey, so the two vivid hues always mean "the rider was actually riding". The values
 * are darkened versions of the accent tokens in `globals.css` because they are drawn as map lines
 * on a pale basemap, where a light accent would disappear.
 */
export const SEGMENT_COLORS: Record<SegmentLabel, string> = {
  upwind: "#14a45c", // Signal green
  reaching: "#0f7c7c", // deep teal: same family as upwind, plainly not upwind
  idle: "#b0ac9f", // quiet: not sailing
  powered_downwind: "#e0763a", // Soft Origin (parawing still flying)
  free_downwind: "#dc4b8e", // Familiar Tone (wing packed, riding swell)
  unclassified: "#8e8a7e", // unknown
  excluded: "#d2cec3", // ignored entirely
};

export function segmentColor(label: SegmentLabel): string {
  return SEGMENT_COLORS[label] ?? SEGMENT_COLORS.unclassified;
}

/** Legend order: what a rider wants to see first is the downwind they came for. */
export const LEGEND_ORDER: SegmentLabel[] = [
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

/** A downwind run as listed in the DW table and numbered on the map. */
export interface DownwindRun {
  /** 1-based number, assigned chronologically so the map badge and the table row agree. */
  n: number;
  segment: Segment;
  label: SegmentLabel;
  /** epoch ms of the first and last point in the run */
  startT: number;
  endT: number;
}

/** True for the two labels that count as a downwind run. */
export function isDownwindRunLabel(label: SegmentLabel): boolean {
  return label === "free_downwind" || label === "powered_downwind";
}

/**
 * Every downwind segment of a plan, numbered in chronological order.
 *
 * Both confirmed runs and the classifier's unconfirmed guesses are included — the map labels them
 * all as candidates — so the numbering is stable whether or not the rider has reviewed them yet.
 * Segments whose label is a downwind kind but which are excluded never appear: exclusion wins.
 */
export function downwindRuns(
  segments: readonly Segment[],
  points: readonly { t: number }[],
): DownwindRun[] {
  const runs: DownwindRun[] = [];
  for (const segment of [...segments].sort((a, b) => a.startIdx - b.startIdx)) {
    const label = effectiveLabel(segment);
    if (!isDownwindRunLabel(label)) continue;
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
