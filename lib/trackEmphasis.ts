/**
 * Which stretches of track the map should make a fuss about.
 *
 * Two different kinds of emphasis meet here, and keeping them apart is the whole point:
 *
 *  1. **A deliberate selection** — the rider clicked a row, a badge or the track itself. That one
 *     stretch gets the halo and the heaviest line, and every other stretch is greyed back to a
 *     neutral so the answer to "where did I go" is legible at a glance.
 *  2. **A passive mark** — on load, nothing is selected, and the longest confirmed downwind run is
 *     drawn a little heavier so the rider can see where their best run was without asking.
 *
 * The passive mark must never survive an active selection. When the two overlapped, selecting any
 * other stretch left *two* emphasised lines on the map — the one the rider chose and the longest
 * one, still in full colour with its halo — which reads as "the longest run is still selected".
 * A rider reported exactly that, so the rule is now explicit: a passive mark yields the moment
 * there is a selection, while the mark itself stays passive (it never greys the map back, because
 * repainting the whole track on load is not what "longest" is worth).
 *
 * This lives outside the map component so it can be tested without a browser or a WebGL context,
 * which is how the overlap got in.
 */

import { effectiveLabel } from "./classify";
import { segmentColor } from "./summary";
import type { EnrichedPoint, SegmentPlan } from "./types";

export interface TrackProps {
  id: string;
  color: string;
  /** the stretch the rider picked: heaviest line, halo, everything else greyed */
  selected: boolean;
  /**
   * the longest confirmed downwind run, marked passively — and only while nothing is selected
   */
  highlight: boolean;
  /** either of the above: this is what gets the halo */
  focus: boolean;
  /** something else is selected, so this stretch steps back */
  dim: boolean;
}

export type TrackFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: TrackProps;
};

/** One straight solid line per segment, coloured by the segment's label. */
export function buildTrackFeatures(points: EnrichedPoint[], plan: SegmentPlan): TrackFeature[] {
  const features: TrackFeature[] = [];
  for (const seg of plan.segments) {
    const from = Math.max(0, seg.startIdx);
    const to = Math.min(points.length - 1, seg.endIdx);
    if (to < from) continue;
    const coordinates: [number, number][] = [];
    for (let i = from; i <= to; i++) coordinates.push([points[i].lon, points[i].lat]);
    if (coordinates.length < 2) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {
        id: seg.id,
        color: segmentColor(effectiveLabel(seg)),
        selected: false,
        highlight: false,
        focus: false,
        dim: false,
      },
    });
  }
  return features;
}

/**
 * Stamp the emphasis for the current selection onto the track features.
 *
 * Note the asymmetry: `highlightId` is only consulted when `selectedId` is null. There is never
 * more than one `focus` feature while something is selected.
 */
export function resolveTrackEmphasis(
  features: readonly TrackFeature[],
  selectedId: string | null,
  highlightId: string | null,
): TrackFeature[] {
  const hasSelection = selectedId != null;
  return features.map((f) => {
    const selected = hasSelection && f.properties.id === selectedId;
    const highlight = !hasSelection && highlightId != null && f.properties.id === highlightId;
    const focus = selected || highlight;
    // Only a deliberate selection greys out the rest; the passive "longest run" mark on load should
    // not repaint the whole map.
    const dim = hasSelection && !selected;
    return { ...f, properties: { ...f.properties, selected, highlight, focus, dim } };
  });
}
