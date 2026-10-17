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
 * Segment colours. Scandinavian palette: teal/blue-green for ordinary sailing, warm amber/orange
 * for downwind surfing, neutral slate for the uncertain and the excluded. The two downwind kinds
 * are far enough apart in hue to read on a dark map.
 */
export const SEGMENT_COLORS: Record<SegmentLabel, string> = {
  upwind: "#2dd4bf", // teal
  reaching: "#38bdf8", // sky
  idle: "#64748b", // slate
  powered_downwind: "#f59e0b", // amber
  free_downwind: "#f97316", // ember orange
  unclassified: "#94a3b8", // light slate
  excluded: "#475569", // dark slate
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
