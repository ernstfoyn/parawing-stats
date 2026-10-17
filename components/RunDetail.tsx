"use client";

/**
 * One stretch of track, opened up.
 *
 * This is what a click on a run is actually for: not "where is it" — the badge already said that —
 * but "how did I ride it". The stretch is cut into equal-duration slices so a lull cannot buy a
 * slice, and each slice reports the speed, the true wind angle and *how much the course turned
 * across it*. Summed, those turns are the difference between a straight blast and a carvathon, and
 * they are the honest measure of "how did I swing it" — nothing here is inferred from a gybe
 * detector, it is just the heading at each end of the slice.
 *
 * The slices are equal duration, not equal distance, and they are cut from the run's own index
 * range, so nothing leaks in from the track either side of it.
 */

import { useMemo } from "react";
import { effectiveLabel } from "@/lib/classify";
import { stretchParts } from "@/lib/metrics";
import { segmentColor, SEGMENT_LABEL_TEXT } from "@/lib/summary";
import {
  convertSpeed,
  formatDistance,
  formatDuration,
  formatSpeed,
  formatTimeInOffset,
  SPEED_UNIT_LABEL,
  type SpeedUnit,
} from "@/lib/units";
import type { EnrichedPoint, Segment, SegmentLabel } from "@/lib/types";

export interface RunDetailProps {
  points: EnrichedPoint[];
  segment: Segment;
  unit: SpeedUnit;
  tzOffsetMin: number | null;
  /** ordinal of this stretch among the runs of its own kind, for the heading */
  ordinal: number;
  onClear: () => void;
  onStep: (delta: -1 | 1) => void;
  canStepBack: boolean;
  canStepForward: boolean;
}

/** A slice per 30 s of riding, clamped: fewer than four says nothing, more than twelve is a table. */
function sliceCount(durationS: number): number {
  return Math.max(4, Math.min(12, Math.round(durationS / 30)));
}

export default function RunDetail({
  points,
  segment,
  unit,
  tzOffsetMin,
  ordinal,
  onClear,
  onStep,
  canStepBack,
  canStepForward,
}: RunDetailProps) {
  const label: SegmentLabel = effectiveLabel(segment);
  const color = segmentColor(label);
  const f = segment.features;

  const parts = useMemo(
    () => stretchParts(points, segment.startIdx, segment.endIdx, sliceCount(f.durationS)),
    [points, segment.startIdx, segment.endIdx, f.durationS],
  );

  const turning = useMemo(() => {
    let total = 0; // absolute: how much carving happened at all
    let net = 0; // signed: how far the course rotated end to end
    let biggest = 0;
    let turns = 0;
    for (const p of parts) {
      if (p.turnDeg == null) continue;
      total += Math.abs(p.turnDeg);
      net += p.turnDeg;
      biggest = Math.max(biggest, Math.abs(p.turnDeg));
      if (Math.abs(p.turnDeg) >= 20) turns++;
    }
    return { total, net, biggest, turns };
  }, [parts]);

  const maxPartSpeed = useMemo(
    () => parts.reduce((m, p) => Math.max(m, p.avgSpeedMps ?? 0), 0),
    [parts],
  );

  const isDownwind = label === "free_downwind" || label === "powered_downwind";
  const vmg = f.avgWindSpeedMps == null ? null : isDownwind ? f.avgVmgDownMps : -f.avgVmgDownMps;
  // The heading names the stretch, so it does not need the label repeated next to it.
  const heading =
    label === "free_downwind"
      ? "Downwind run"
      : label === "powered_downwind"
        ? "Powered reach"
        : label === "upwind"
          ? "Upwind beat"
          : SEGMENT_LABEL_TEXT[label];

  return (
    <div className="border-t border-ink bg-sunk/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="run-badge" data-kind={segment.manualLabel == null ? "estimate" : label}>
          {ordinal}
        </span>
        <div className="min-w-0">
          <p className="mono text-[0.68rem] uppercase tracking-[0.08em] text-graphite">
            {heading} {ordinal}
            {segment.manualLabel == null ? " · classifier candidate" : " · labelled by you"}
          </p>
          <p className="mono text-[0.68rem] text-grey">
            {formatTimeInOffset(parts[0]?.startT ?? 0, tzOffsetMin, true)}–
            {formatTimeInOffset(
              parts[parts.length - 1]?.endT ?? 0,
              tzOffsetMin,
              true,
            )}{" "}
            · {parts.length} slices of equal duration
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="btn btn-ghost !px-2 !py-1"
            onClick={() => onStep(-1)}
            disabled={!canStepBack}
            title="Previous stretch"
          >
            ←
          </button>
          <button
            type="button"
            className="btn btn-ghost !px-2 !py-1"
            onClick={() => onStep(1)}
            disabled={!canStepForward}
            title="Next stretch"
          >
            →
          </button>
          <button type="button" className="btn btn-ghost !px-2 !py-1" onClick={onClear}>
            whole track
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-7">
        <Mini label="Distance" value={formatDistance(f.distanceM, 3)} />
        <Mini label="Time" value={formatDuration(f.durationS)} />
        <Mini label="Avg speed" value={formatSpeed(f.avgSpeedMps, unit)} unit={SPEED_UNIT_LABEL[unit]} />
        <Mini label="Max speed" value={formatSpeed(f.maxSpeedMps, unit)} unit={SPEED_UNIT_LABEL[unit]} />
        <Mini
          label={isDownwind ? "Avg VMG ↓" : "Avg VMG ↑"}
          value={vmg == null ? "—" : formatSpeed(vmg, unit)}
          unit={vmg == null ? undefined : SPEED_UNIT_LABEL[unit]}
          hint={vmg == null ? "no wind on this stretch" : undefined}
        />
        <Mini
          label="Total turning"
          value={`${Math.round(turning.total)}°`}
          hint={`${turning.turns} slice${turning.turns === 1 ? "" : "s"} over 20°`}
        />
        <Mini
          label="Net rotation"
          value={`${turning.net >= 0 ? "+" : ""}${Math.round(turning.net)}°`}
          hint={turning.net >= 0 ? "ended up turned to starboard" : "ended up turned to port"}
        />
      </div>

      {/* Speed and turning, slice by slice. Bar length is speed; the tick is that slice's turn. */}
      <div className="mt-4 space-y-1">
        {parts.map((p) => {
          const width = maxPartSpeed > 0 ? ((p.avgSpeedMps ?? 0) / maxPartSpeed) * 100 : 0;
          const turn = p.turnDeg ?? 0;
          return (
            <div
              key={p.n}
              className="grid grid-cols-[26px_minmax(0,1fr)_70px] items-center gap-x-3 text-[0.66rem] sm:grid-cols-[26px_72px_minmax(0,1fr)_64px_56px]"
            >
              <span className="mono text-grey">{p.n}</span>
              <span className="mono hidden text-grey sm:inline">
                {formatTimeInOffset(p.startT, tzOffsetMin)}
              </span>
              <span className="relative block h-[9px] rounded-[1px] bg-card">
                <span
                  className="absolute inset-y-0 left-0 rounded-[1px]"
                  style={{ width: `${Math.max(2, width)}%`, backgroundColor: color }}
                />
              </span>
              <span className="mono text-right tabular-nums text-ink">
                {p.avgSpeedMps == null ? "—" : `${convertSpeed(p.avgSpeedMps, unit).toFixed(1)}`}
              </span>
              <span
                className="mono hidden text-right tabular-nums sm:inline"
                style={{ color: Math.abs(turn) >= 20 ? "#121211" : "#8e8a7e" }}
                title="How much the course turned across this slice"
              >
                {p.turnDeg == null ? "—" : `${turn > 0 ? "+" : ""}${Math.round(turn)}°`}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-1 mono text-[0.6rem] text-grey sm:text-right">
        speed in {SPEED_UNIT_LABEL[unit]} · turn per slice, + is to starboard
      </p>

      <p className="mt-2 text-[0.68rem] leading-relaxed text-grey">
        Slices are equal <span className="mono">duration</span>, so slowing down cannot earn a slice
        of its own. Turning is measured from the mean course at each end of a slice — it is a
        description of the track, not a gybe or tack count.
      </p>
    </div>
  );
}

function Mini({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="label mb-1">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="whitespace-nowrap text-[1.05rem] font-semibold leading-none tracking-tight text-ink">
          {value}
        </span>
        {unit && <span className="mono text-[0.62rem] text-grey">{unit}</span>}
      </div>
      {hint && <div className="mt-1 text-[0.64rem] leading-snug text-grey">{hint}</div>}
    </div>
  );
}
