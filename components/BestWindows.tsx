"use client";

/**
 * Best efforts: the fastest one, two and three minute windows of the session.
 *
 * Each row is a real window of elapsed time, found by `lib/bestWindows.ts`, and the three bars per
 * duration are scaled against each other so the lengths are comparable down the column. Speed is
 * drawn in ink, upwind VMG in signal green and the along-wind component in Soft Origin, matching the
 * rest of the app. Only the upwind figure is called VMG: a downwind stretch is not judged on VMG.
 *
 * A bar can be empty: when a rider spends a whole window on a reach, upwind VMG is at or below
 * zero and the number is shown for what it is rather than clamped to look better.
 */

import { useMemo } from "react";
import { findEffort, hasVmgWindows, type EffortMetric, type EffortWindow } from "@/lib/bestWindows";
import {
  formatSpeed,
  formatTimeInOffset,
  SPEED_UNIT_LABEL,
  type SpeedUnit,
} from "@/lib/units";
import { EmptyState } from "./ui";

const METRIC_ROWS: { metric: EffortMetric; label: string; color: string }[] = [
  { metric: "speed", label: "Speed", color: "#121211" },
  { metric: "vmgUp", label: "VMG ↑", color: "#14a45c" },
  { metric: "vmgDown", label: "Along ↓", color: "#e0763a" },
];

export interface BestWindowsProps {
  windows: EffortWindow[];
  unit: SpeedUnit;
  tzOffsetMin: number | null;
  /**
   * The session average for each metric. Drawn as a tick on every bar, because "best 2 minutes" is
   * only meaningful next to what the rider did for the other 48 — and on a steady session the three
   * bars can otherwise look identical.
   */
  reference?: Partial<Record<EffortMetric, number | null>>;
}

export default function BestWindows({
  windows,
  unit,
  tzOffsetMin,
  reference,
}: BestWindowsProps) {
  const minutes = useMemo(
    () => [...new Set(windows.map((w) => w.minutes))].sort((a, b) => a - b),
    [windows],
  );

  const maxByMetric = useMemo(() => {
    const m: Record<EffortMetric, number> = { speed: 0, vmgUp: 0, vmgDown: 0 };
    for (const w of windows) m[w.metric] = Math.max(m[w.metric], w.meanMps);
    return m;
  }, [windows]);

  if (windows.length === 0) {
    return (
      <EmptyState
        title="No window this long"
        body="The session is shorter than the shortest window, or too much of it sits inside a recording gap, so no honest best effort can be reported."
      />
    );
  }

  const fastest1 = findEffort(windows, "speed", minutes[0]);
  const hasVmg = hasVmgWindows(windows);

  return (
    <div>
      <div className="space-y-4">
        {minutes.map((min) => (
          <div key={min}>
            <div className="mb-2 flex items-center gap-2 border-b border-quiet pb-1">
              <span className="mono text-[0.64rem] font-bold tracking-[0.12em] text-ink">
                {min} MIN
              </span>
              <span className="panel-kicker">best window</span>
            </div>
            <div className="space-y-1.5">
              {METRIC_ROWS.map(({ metric, label, color }) => {
                const w = findEffort(windows, metric, min);
                if (!w) return null;
                const max = maxByMetric[metric] || 1;
                const width = Math.max(0, (w.meanMps / max) * 100);
                const avg = reference?.[metric] ?? null;
                const avgShown = avg != null && Number.isFinite(avg) && avg > 0;
                return (
                  <div
                    key={metric}
                    className="grid grid-cols-[46px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[46px_minmax(0,1fr)_190px]"
                  >
                    <span className="mono text-[0.64rem] uppercase tracking-[0.06em] text-grey">
                      {label}
                    </span>
                    <div className="effort-track" title={`${Math.round(w.coveredS)} s of data`}>
                      <div
                        className="effort-fill"
                        style={{ width: `${width}%`, backgroundColor: color }}
                      />
                      {avgShown && (
                        <div
                          className="effort-ref"
                          style={{ left: `${Math.min(100, (avg / max) * 100)}%` }}
                          title={`Session average ${formatSpeed(avg, unit)} ${SPEED_UNIT_LABEL[unit]}`}
                        />
                      )}
                    </div>
                    <span className="mono col-start-2 text-left text-[0.68rem] tabular-nums text-ink sm:col-start-3 sm:text-right">
                      {formatSpeed(w.meanMps, unit)} {SPEED_UNIT_LABEL[unit]}
                      {unit !== "mps" && (
                        <span className="text-grey"> / {w.meanMps.toFixed(1)} m/s</span>
                      )}
                      <span className="text-grey"> · {formatTimeInOffset(w.startT, tzOffsetMin)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {fastest1 && (
        <p className="mt-4 border-t border-quiet pt-3 text-[0.72rem] leading-relaxed text-graphite">
          Fastest {fastest1.minutes}-min average:{" "}
          <span className="mono font-bold text-ink">
            {formatSpeed(fastest1.meanMps, unit)} {SPEED_UNIT_LABEL[unit]}
          </span>
          {unit !== "mps" && (
            <span className="mono text-grey"> / {fastest1.meanMps.toFixed(1)} m/s</span>
          )}{" "}
          <span className="mono text-grey">
            ({formatTimeInOffset(fastest1.startT, tzOffsetMin)}–
            {formatTimeInOffset(fastest1.endT, tzOffsetMin)})
          </span>
        </p>
      )}

      <p className="mt-2 text-[0.68rem] leading-relaxed text-grey">
        Windows are elapsed time, weighted by duration rather than by sample count, so a track
        recorded at 0.25 Hz is not compared unfairly with a 1 Hz one. A window the track cannot fill
        — or one that is mostly a recording gap — is reported as nothing.
        {reference && hasVmg ? " The tick on each bar is the session average." : ""}
        {hasVmg ? "" : " With no wind set there is no VMG to measure, so only speed is shown."}
      </p>
    </div>
  );
}
