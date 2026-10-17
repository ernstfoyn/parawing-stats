"use client";

/**
 * Editable segment timeline.
 *
 * The plan is a contiguous tiling of the track, so the timeline is a single stacked bar whose block
 * widths are real durations. Selecting a block opens its editor: relabel, split at the current
 * cursor, merge with a neighbour, or clear the manual label back to the classifier's guess. Every
 * operation returns a new plan and the dashboard recalculates immediately.
 *
 * Nothing here claims to know whether the parawing was flying: a dashed block is an unconfirmed
 * estimate, and the reasons behind the guess are always one click away.
 */

import { useMemo } from "react";
import {
  isDownwindLabel,
  mergeSegments,
  resetToAuto,
  setSegmentLabel,
  splitSegment,
} from "@/lib/classify";
import { segmentColor, SEGMENT_LABEL_HINT, SEGMENT_LABEL_TEXT, LEGEND_ORDER } from "@/lib/summary";
import {
  formatDistance,
  formatDuration,
  formatSpeed,
  formatTimeInOffset,
  type SpeedUnit,
} from "@/lib/units";
import { effectiveLabel } from "@/lib/classify";
import { USER_LABELS } from "@/lib/types";
import type { EnrichedPoint, Segment, SegmentLabel, SegmentPlan } from "@/lib/types";
import { Chip, Dot } from "./ui";

export interface SegmentTimelineProps {
  points: EnrichedPoint[];
  plan: SegmentPlan;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  highlightId: string | null;
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
  onPlanChange: (plan: SegmentPlan) => void;
  tzOffsetMin: number | null;
  unit: SpeedUnit;
}

export default function SegmentTimeline({
  points,
  plan,
  selectedId,
  onSelect,
  highlightId,
  hoverIdx,
  onHoverIdx,
  onPlanChange,
  tzOffsetMin,
  unit,
}: SegmentTimelineProps) {
  const totalS = useMemo(
    () =>
      plan.segments.reduce((a, s) => a + Math.max(0, s.features.durationS), 0) || 1,
    [plan],
  );

  const selected = selectedId ? plan.segments.find((s) => s.id === selectedId) ?? null : null;

  const cursorPercent = useMemo(() => {
    if (hoverIdx == null || points.length < 2) return null;
    const t0 = points[0].t;
    const total = points[points.length - 1].t - t0;
    if (total <= 0) return null;
    return ((points[hoverIdx].t - t0) / total) * 100;
  }, [hoverIdx, points]);

  const canSplit =
    selected != null && hoverIdx != null && hoverIdx > selected.startIdx && hoverIdx <= selected.endIdx;

  return (
    <div>
      {/* -------------------------------------------------------------- the bar */}
      <div className="relative">
        <div className="flex h-9 w-full overflow-hidden rounded-lg border border-line-soft">
          {plan.segments.map((seg) => {
            const label = effectiveLabel(seg);
            const width = (Math.max(0, seg.features.durationS) / totalS) * 100;
            const isSelected = seg.id === selectedId;
            const isHighlight = seg.id === highlightId;
            return (
              <button
                key={seg.id}
                type="button"
                title={`${SEGMENT_LABEL_TEXT[label]} · ${formatDistance(seg.features.distanceM)} · ${formatDuration(seg.features.durationS)}`}
                onClick={() => onSelect(isSelected ? null : seg.id)}
                onMouseEnter={() => onHoverIdx(seg.endIdx)}
                onMouseLeave={() => onHoverIdx(null)}
                className="relative h-full cursor-pointer border-r border-abyss/60 transition-opacity last:border-r-0 hover:opacity-85"
                style={{
                  width: `${Math.max(width, 0.3)}%`,
                  backgroundColor: segmentColor(label),
                  opacity: seg.manualLabel == null ? 0.55 : 1,
                  outline: isSelected
                    ? "2px solid #ffffff"
                    : isHighlight
                      ? "2px solid rgba(233,241,250,0.7)"
                      : undefined,
                  outlineOffset: isSelected || isHighlight ? "-2px" : undefined,
                }}
              />
            );
          })}
        </div>
        {cursorPercent != null && (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-snow/80"
            style={{ left: `${Math.min(100, Math.max(0, cursorPercent))}%` }}
          />
        )}
      </div>

      {/* ------------------------------------------------------------ legend row */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {LEGEND_ORDER.map((label) => (
          <span key={label} className="inline-flex items-center gap-1.5 text-[0.68rem] text-fog">
            <Dot color={segmentColor(label)} />
            {SEGMENT_LABEL_TEXT[label]}
          </span>
        ))}
        <span className="text-[0.68rem] text-fog/80">
          Faded blocks are the classifier&apos;s estimate; solid ones are your decision.
        </span>
      </div>

      {/* --------------------------------------------------------- segment editor */}
      <div className="mt-4">
        {selected ? (
          <SegmentEditor
            seg={selected}
            points={points}
            plan={plan}
            canSplit={canSplit}
            hoverIdx={hoverIdx}
            onPlanChange={onPlanChange}
            onSelect={onSelect}
            tzOffsetMin={tzOffsetMin}
            unit={unit}
          />
        ) : (
          <p className="text-xs text-fog">
            Select a block above (or a part of the track on the map) to edit its classification.
          </p>
        )}
      </div>
    </div>
  );
}

function SegmentEditor({
  seg,
  points,
  plan,
  canSplit,
  hoverIdx,
  onPlanChange,
  onSelect,
  tzOffsetMin,
  unit,
}: {
  seg: Segment;
  points: EnrichedPoint[];
  plan: SegmentPlan;
  canSplit: boolean;
  hoverIdx: number | null;
  onPlanChange: (p: SegmentPlan) => void;
  onSelect: (id: string | null) => void;
  tzOffsetMin: number | null;
  unit: SpeedUnit;
}) {
  const label = effectiveLabel(seg);
  const f = seg.features;
  const start = points[seg.startIdx];
  const end = points[seg.endIdx];

  return (
    <div className="rounded-lg border border-line-soft bg-ink p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip color={segmentColor(label)}>{SEGMENT_LABEL_TEXT[label]}</Chip>
        {seg.manualLabel == null ? (
          <Chip title="The classifier guessed this from GPS and wind only.">
            estimate · {Math.round(seg.auto.confidence * 100)}% confident
          </Chip>
        ) : (
          <Chip color="#2dd4bf" title="You set this label; it overrides the classifier.">
            your label
          </Chip>
        )}
        {start && end && (
          <span className="text-[0.68rem] text-fog">
            {formatTimeInOffset(start.t, tzOffsetMin)}–{formatTimeInOffset(end.t, tzOffsetMin)}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Mini label="Distance" value={formatDistance(f.distanceM)} />
        <Mini label="Duration" value={formatDuration(f.durationS)} />
        <Mini label="Avg speed" value={`${formatSpeed(f.avgSpeedMps, unit)} ${unit}`} />
        <Mini label="Max speed" value={`${formatSpeed(f.maxSpeedMps, unit)} ${unit}`} />
        <Mini label="Avg TWA" value={Number.isFinite(f.avgTwaDeg) ? `${Math.round(f.avgTwaDeg)}°` : "—"} />
        <Mini
          label="Avg VMG down"
          value={`${formatSpeed(f.avgVmgDownMps, unit)} ${unit}`}
        />
        <Mini label="Deep run" value={`${Math.round(f.deadRunFraction * 100)}%`} />
        <Mini label="Moving" value={`${Math.round(f.movingFraction * 100)}%`} />
      </div>

      {/* relabel */}
      <div className="mt-3">
        <div className="label">Set the label</div>
        <div className="flex flex-wrap gap-1.5">
          {USER_LABELS.map((l) => (
            <LabelButton
              key={l}
              label={l}
              active={seg.manualLabel === l}
              onClick={() => onPlanChange(setSegmentLabel(plan, seg.id, seg.manualLabel === l ? null : l))}
            />
          ))}
        </div>
      </div>

      {/* structure */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          className="btn"
          disabled={!canSplit}
          title={
            canSplit
              ? "Split this segment at the point under the cursor."
              : "Hover the map or the charts to place the cursor inside this segment first."
          }
          onClick={() => {
            if (hoverIdx == null) return;
            onPlanChange(splitSegment(plan, points, seg.id, hoverIdx));
          }}
        >
          Split at cursor
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            onPlanChange(mergeSegments(plan, points, seg.id, "prev"))
          }
        >
          Merge with previous
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            onPlanChange(mergeSegments(plan, points, seg.id, "next"))
          }
        >
          Merge with next
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={seg.manualLabel == null}
          onClick={() => onPlanChange(setSegmentLabel(plan, seg.id, null))}
        >
          Clear label
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          title="Discard every manual correction in this session."
          onClick={() => {
            onPlanChange(resetToAuto(plan));
            onSelect(null);
          }}
        >
          Reset all to auto
        </button>
      </div>

      {/* reasons */}
      {seg.auto.reasons.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line-soft pt-3 text-[0.72rem] leading-relaxed text-fog">
          {seg.auto.reasons.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-line">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}
      {isDownwindLabel(label) && (
        <p className="mt-2 text-[0.68rem] leading-relaxed text-ember/90">
          Confirmed downwind segments feed the downwind statistics at the bottom of this page.
        </p>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[0.62rem] font-semibold uppercase tracking-[0.07em] text-fog">{label}</div>
      <div className="tabular-nums text-mist">{value}</div>
    </div>
  );
}

function LabelButton({
  label,
  active,
  onClick,
}: {
  label: SegmentLabel;
  active: boolean;
  onClick: () => void;
}) {
  const color = segmentColor(label);
  return (
    <button
      type="button"
      title={SEGMENT_LABEL_HINT[label]}
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.72rem] font-medium transition-colors"
      style={{
        borderColor: active ? color : "#22324a",
        backgroundColor: active ? `${color}22` : "transparent",
        color: active ? color : "#b3c4d8",
      }}
    >
      <Dot color={color} />
      {SEGMENT_LABEL_TEXT[label]}
    </button>
  );
}
