"use client";

/**
 * One straight-line answer to "how far did I go, how long, and how fast", for either a set of
 * downwind runs or a set of upwind beats.
 *
 * The map badges each run with a number; this table is the same list in the same numbering, so a
 * rider can read the numbers and then find the run on the map. Rows are sorted by distance (longest
 * first, which is the question actually being asked) while the badge numbers stay chronological.
 *
 * Every row states the speed in the chosen unit *and* in m/s, because the two are quoted
 * interchangeably in wingfoil logs and a single number invites a mix-up.
 *
 * The `compact` layout drops the label and confidence columns so the table can sit beside the map
 * in a narrow column; the badge keeps that information instead, drawn exactly like the map badge
 * (filled = you confirmed it, open = the classifier's candidate).
 *
 * These are *candidates*, not measurements: GPS and station wind cannot see whether the parawing
 * was packed down, which is what makes a stretch a downwind run rather than a powered reach. The
 * table says so rather than implying the label is a fact.
 */

import { useMemo } from "react";
import { downwindRuns, segmentColor, SEGMENT_LABEL_TEXT, upwindRuns, type TrackRun } from "@/lib/summary";
import {
  convertSpeed,
  formatDistance,
  formatDuration,
  formatTimeInOffset,
  type SpeedUnit,
} from "@/lib/units";
import type { EnrichedPoint, SegmentPlan } from "@/lib/types";
import { EmptyState } from "./ui";

export type RunsKind = "downwind" | "upwind";

export interface RunsTableProps {
  kind: RunsKind;
  points: EnrichedPoint[];
  plan: SegmentPlan;
  unit: SpeedUnit;
  tzOffsetMin: number | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** true when no wind direction exists, so an empty list is expected rather than the rider's doing */
  needsWind?: boolean;
  /** narrower layout for the column beside the map */
  compact?: boolean;
}

const COPY = {
  downwind: {
    labelHeader: "Run",
    vmgHeader: "VMG ↓",
    emptyTitle: "No downwind candidates on this track",
    emptyBody:
      "Nothing is downwind yet — neither by the classifier nor by you. A stretch counts as downwind when it runs within 55° of straight downwind, which is too deep to hold with the parawing still flying. Label a block in the segment timeline below and it appears here immediately.",
    emptyBodyNoWind:
      "There is no wind direction yet, so there is nothing to measure a course against and no stretch can be called downwind. Set a wind source and the runs appear here, numbered on the map.",
    footnote:
      "Open badges are the classifier's candidates; filled badges are labels you confirmed, and the badge number is the order you sailed the stretches in. Rows are listed longest first. GPS and station wind cannot show whether the wing was packed, so every row here is a candidate until you say otherwise, and a powered reach is never listed here.",
  },
  upwind: {
    labelHeader: "Beat",
    vmgHeader: "VMG ↑",
    emptyTitle: "No upwind beats on this track",
    emptyBody:
      "Nothing is labelled upwind yet — neither by the classifier nor by you. With no wind set there is nothing to tell upwind from downwind, so label a block in the timeline below.",
    emptyBodyNoWind:
      "No wind direction is set, so no stretch can be called upwind — and without one there is no VMG to report either. Set a wind source and the beats and their VMG appear here.",
    footnote:
      "VMG is the part of your speed that actually went towards the wind, which is the number that says whether a beat was worth sailing. It is only as good as the wind it is measured against. The badge number is the order you sailed the stretches in; rows are listed longest first.",
  },
} as const;

export default function RunsTable({
  kind,
  points,
  plan,
  unit,
  tzOffsetMin,
  selectedId,
  onSelect,
  needsWind = false,
  compact = false,
}: RunsTableProps) {
  const copy = COPY[kind];

  const runs = useMemo(
    () =>
      kind === "downwind"
        ? downwindRuns(plan.segments, points)
        : upwindRuns(plan.segments, points),
    [plan, points, kind],
  );

  const rows = useMemo(
    () => [...runs].sort((a, b) => b.segment.features.distanceM - a.segment.features.distanceM),
    [runs],
  );

  const totals = useMemo(() => {
    let distanceM = 0;
    let durationS = 0;
    for (const r of runs) {
      distanceM += r.segment.features.distanceM;
      durationS += r.segment.features.durationS;
    }
    return { distanceM, durationS, count: runs.length };
  }, [runs]);

  if (rows.length === 0) {
    return (
      <EmptyState
        title={needsWind ? "Waiting on the wind" : copy.emptyTitle}
        body={needsWind ? copy.emptyBodyNoWind : copy.emptyBody}
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
              {!compact && <th className="w-full">{copy.labelHeader}</th>}
              <th className="num">Dist.</th>
              <th className="num">Time</th>
              <th className="num">{unit === "mps" ? "Speed m/s" : `${unit} / m/s`}</th>
              <th className="num">{copy.vmgHeader}</th>
              {!compact && <th>Est.</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((run) => {
              const f = run.segment.features;
              const selected = run.segment.id === selectedId;
              const candidate = run.segment.manualLabel == null;
              return (
                <tr
                  key={run.segment.id}
                  aria-selected={selected}
                  className="cursor-pointer"
                  onClick={() => onSelect(selected ? null : run.segment.id)}
                  title={
                    selected
                      ? "Clear the highlight on the map"
                      : "Highlight this stretch on the map and open its editor"
                  }
                >
                  <td className="!px-2">
                    <RunBadge run={run} candidate={candidate} selected={selected} />
                  </td>
                  <td>{formatTimeInOffset(run.startT, tzOffsetMin)}</td>
                  {!compact && (
                    <td>
                      <span className="flex items-center gap-1.5">
                        <span
                          className="inline-block size-2 shrink-0 rounded-[1px]"
                          style={{ backgroundColor: segmentColor(run.label) }}
                        />
                        <span className="text-graphite">{SEGMENT_LABEL_TEXT[run.label]}</span>
                      </span>
                    </td>
                  )}
                  <td className="num">{formatDistance(f.distanceM, 3)}</td>
                  <td className="num">{formatDuration(f.durationS)}</td>
                  <td className="num font-bold">{speedPair(f.avgSpeedMps, unit)}</td>
                  <td className="num">{speedPair(runVmg(run, kind), unit)}</td>
                  {!compact && (
                    <td className="text-grey">
                      {candidate ? `${Math.round(run.segment.auto.confidence * 100)}%` : "you"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-quiet pt-3 text-[0.72rem]">
        <p className="mono text-graphite">
          {totals.count} stretch{totals.count === 1 ? "" : "es"} ·{" "}
          <span className="font-bold text-ink">
            {formatDistance(totals.distanceM, 3)} / {formatDuration(totals.durationS)}
          </span>
        </p>
        <p className="mono text-grey">
          Longest {formatTimeInOffset(longest.startT, tzOffsetMin)}–
          {formatTimeInOffset(longest.endT, tzOffsetMin)}
        </p>
      </div>
      <p className="mt-2 text-[0.68rem] leading-relaxed text-grey">{copy.footnote}</p>
    </div>
  );
}

/** The same square the map draws, so a row and a badge are obviously the same thing. */
function RunBadge({
  run,
  candidate,
  selected,
}: {
  run: TrackRun;
  candidate: boolean;
  selected: boolean;
}) {
  return (
    <span
      className="run-badge"
      data-kind={candidate ? "estimate" : run.label}
      data-selected={selected ? "true" : "false"}
      title={`${SEGMENT_LABEL_TEXT[run.label]}${candidate ? " (classifier candidate)" : " (confirmed by you)"}`}
    >
      {run.n}
    </span>
  );
}

/**
 * VMG for a run in its own direction.
 *
 * Upwind VMG is the exact negative of downwind VMG at every sample (`vmg()` computes
 * `speed·cos(twa)` for up and `-speed·cos(twa)` for down), so negating the stored time-weighted mean
 * is exact rather than an approximation.
 *
 * A segment with no usable wind carries `avgWindSpeedMps === null`, and its VMG fields are a
 * placeholder 0 — showing "0.0 kn" there would state a measurement that was never taken.
 */
function runVmg(run: TrackRun, kind: RunsKind): number | null {
  const f = run.segment.features;
  if (f.avgWindSpeedMps == null) return null;
  return kind === "downwind" ? f.avgVmgDownMps : -f.avgVmgDownMps;
}

/** "11.1 / 5.7" — chosen unit and m/s, or just m/s when that is the chosen unit. */
function speedPair(mps: number | null, unit: SpeedUnit): string {
  if (mps == null || !Number.isFinite(mps)) return "—";
  if (unit === "mps") return `${mps.toFixed(1)} m/s`;
  return `${convertSpeed(mps, unit).toFixed(1)} / ${mps.toFixed(1)}`;
}
