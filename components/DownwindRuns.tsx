"use client";

/**
 * Downwind runs, as a table.
 *
 * The map badges each run with a number; this table is the same list in the same numbering, so a
 * rider can read the numbers and then find the run on the map. Rows are sorted by distance (longest
 * first, which is the question actually being asked) while the badge numbers stay chronological.
 *
 * Every row states the speed in the chosen unit *and* in m/s, because the two are quoted
 * interchangeably in wingfoil logs and a single number invites a mix-up.
 */

import { useMemo } from "react";
import { segmentColor, downwindRuns, SEGMENT_LABEL_TEXT } from "@/lib/summary";
import {
  convertSpeed,
  formatDistance,
  formatDuration,
  formatTimeInOffset,
  type SpeedUnit,
} from "@/lib/units";
import type { EnrichedPoint, SegmentPlan } from "@/lib/types";
import { Dot, EmptyState } from "./ui";

export interface DownwindRunsProps {
  points: EnrichedPoint[];
  plan: SegmentPlan;
  unit: SpeedUnit;
  tzOffsetMin: number | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function DownwindRuns({
  points,
  plan,
  unit,
  tzOffsetMin,
  selectedId,
  onSelect,
}: DownwindRunsProps) {
  const runs = useMemo(() => downwindRuns(plan.segments, points), [plan, points]);

  const rows = useMemo(
    () =>
      [...runs].sort(
        (a, b) => b.segment.features.distanceM - a.segment.features.distanceM,
      ),
    [runs],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No downwind runs on this track"
        body="Nothing is labelled downwind yet — neither by the classifier nor by you. Label a block in the segment timeline below and it appears here immediately."
      />
    );
  }

  const longest = rows[0];

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="!px-2">#</th>
              <th>Start</th>
              <th className="w-full">Run</th>
              <th className="num">Dist.</th>
              <th className="num">Time</th>
              <th className="num">{unit === "mps" ? "Speed m/s" : `${unit} / m/s`}</th>
              <th className="num">VMG ↓</th>
              <th>Est.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((run) => {
              const f = run.segment.features;
              const selected = run.segment.id === selectedId;
              return (
                <tr
                  key={run.segment.id}
                  aria-selected={selected}
                  className="cursor-pointer"
                  onClick={() => onSelect(selected ? null : run.segment.id)}
                  title="Show this run on the map and open its editor"
                >
                  <td className="!px-2 text-grey">{run.n}</td>
                  <td>{formatTimeInOffset(run.startT, tzOffsetMin)}</td>
                  <td>
                    <span className="flex items-center gap-1.5">
                      <Dot color={segmentColor(run.label)} />
                      <span className="text-graphite">{SEGMENT_LABEL_TEXT[run.label]}</span>
                    </span>
                  </td>
                  <td className="num">{formatDistance(f.distanceM, 3)}</td>
                  <td className="num">{formatDuration(f.durationS)}</td>
                  <td className="num font-bold">{speedPair(f.avgSpeedMps, unit)}</td>
                  <td className="num">{speedPair(f.avgVmgDownMps, unit)}</td>
                  <td className="text-grey">
                    {run.segment.manualLabel == null
                      ? `${Math.round(run.segment.auto.confidence * 100)}%`
                      : "you"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-quiet pt-3 text-[0.72rem]">
        <p className="mono text-graphite">
          Longest:{" "}
          <span className="font-bold text-ink">
            {formatDistance(longest.segment.features.distanceM, 3)} /{" "}
            {formatDuration(longest.segment.features.durationS)}
          </span>
        </p>
        <p className="mono text-grey">
          {formatTimeInOffset(longest.startT, tzOffsetMin)}–
          {formatTimeInOffset(longest.endT, tzOffsetMin)}
        </p>
      </div>
      <p className="mt-2 text-[0.68rem] leading-relaxed text-grey">
        Rows marked <span className="mono">Est.</span> are the classifier&apos;s guesses, dashed on
        the map. Nothing here counts toward the downwind statistics until you confirm the label.
      </p>
    </div>
  );
}

/** "11.1 / 5.7" — chosen unit and m/s, or just m/s when that is the chosen unit. */
function speedPair(mps: number | null, unit: SpeedUnit): string {
  if (mps == null || !Number.isFinite(mps)) return "—";
  if (unit === "mps") return `${mps.toFixed(1)} m/s`;
  return `${convertSpeed(mps, unit).toFixed(1)} / ${mps.toFixed(1)}`;
}
