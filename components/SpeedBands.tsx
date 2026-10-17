"use client";

/**
 * How long — and how far — at which speed, over the downwind runs only.
 *
 * This is the answer to "where did I actually spend my downwind time", which is a different
 * question from the whole-session histogram. The bands are chosen so their edges land on round
 * numbers *in the unit you are reading*: 2 knots, 1 m/s or 4 km/h, never "11.7–13.6 kn" because the
 * storage unit happens to be metres per second. The internal edges are exact multiples of the
 * displayed band width, so the conversion back for the label is lossless.
 *
 * The sum of the bands is the same total the runs table reports — the ranges are the runs
 * themselves, and the walk never bridges the gap between two of them.
 */

import { useMemo } from "react";
import { speedBandsInRanges, type IndexRange } from "@/lib/metrics";
import type { EnrichedPoint } from "@/lib/types";
import { formatDuration, SPEED_UNIT_LABEL, type SpeedUnit } from "@/lib/units";
import { SpeedHistogram } from "./Charts";

export interface SpeedBandsProps {
  points: EnrichedPoint[];
  ranges: IndexRange[];
  unit: SpeedUnit;
}

/**
 * Band width and ceiling per display unit, in m/s.
 * 1 kn = 1/1.943844 m/s exactly, so `n` knots is `n / 1.943844` m/s — and converting that back
 * gives `n` again, which is why the labels come out as clean whole numbers.
 */
const KN = 1 / 1.943844;
const KMH = 1 / 3.6;

/** Metres per second in one unit of the displayed unit. */
const UNIT_MPS: Record<SpeedUnit, number> = { kn: KN, mps: 1, kmh: KMH };

const SPEC: Record<SpeedUnit, { widthMps: number; maxMps: number }> = {
  kn: { widthMps: 2 * KN, maxMps: 42 * KN },
  mps: { widthMps: 1, maxMps: 20 },
  kmh: { widthMps: 4 * KMH, maxMps: 76 * KMH },
};

export default function SpeedBands({ points, ranges, unit }: SpeedBandsProps) {
  const spec = SPEC[unit];

  const bands = useMemo(
    () => speedBandsInRanges(points, ranges, spec.widthMps, spec.maxMps),
    [points, ranges, spec.widthMps, spec.maxMps],
  );

  const shown = useMemo(() => bands.filter((b) => b.timeS > 0), [bands]);

  const total = useMemo(
    () => shown.reduce((acc, b) => ({ timeS: acc.timeS + b.timeS, distanceM: acc.distanceM + b.distanceM }), {
      timeS: 0,
      distanceM: 0,
    }),
    [shown],
  );

  if (shown.length === 0) {
    return (
      <p className="text-[0.76rem] text-grey">
        No usable samples inside the downwind runs, so there is no speed distribution to show.
      </p>
    );
  }

  const maxShare = shown.reduce((m, b) => Math.max(m, b.share), 0);

  return (
    <div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div>
          <div className="label mb-1">Time at speed</div>
          <SpeedHistogram buckets={bands} unit={unit} />
        </div>

        <div className="overflow-x-auto">
          <div className="label mb-1">The same numbers, exactly</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  {SPEED_UNIT_LABEL[unit]}
                </th>
                <th className="num">Time</th>
                <th className="num">Dist.</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.fromMps}>
                  <td className="mono">
                    {bandLabel(b.fromMps, unit)}–{bandLabel(b.toMps, unit)}
                  </td>
                  <td className="num font-bold">{formatDuration(b.timeS)}</td>
                  <td className="num">{(b.distanceM / 1000).toFixed(2)} km</td>
                  <td className="num text-grey">
                    <span className="flex items-center justify-end gap-2">
                      <span
                        className="hidden h-[6px] rounded-[1px] bg-sunk sm:block"
                        style={{ width: `${(b.share / (maxShare || 1)) * 46}px` }}
                      >
                        <span
                          className="block h-full rounded-[1px] bg-ink"
                          style={{ width: `${(b.share / (maxShare || 1)) * 100}%` }}
                        />
                      </span>
                      {(b.share * 100).toFixed(0)}%
                    </span>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="mono text-graphite">all</td>
                <td className="num font-bold">{formatDuration(total.timeS)}</td>
                <td className="num font-bold">{(total.distanceM / 1000).toFixed(2)} km</td>
                <td className="num text-grey">100%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-2 text-[0.68rem] leading-relaxed text-grey">
        Time is weighted by the real interval between samples, so a track logged at 0.25 Hz is not
        compared unfairly with a 1 Hz one. Bands where you spent no time are left out rather than
        printed as a row of zeroes.
      </p>
    </div>
  );
}

/** A band edge in the displayed unit. Exact, because every edge is a whole multiple of the width. */
function bandLabel(edgeMps: number, unit: SpeedUnit): string {
  return (edgeMps / UNIT_MPS[unit]).toFixed(0);
}
