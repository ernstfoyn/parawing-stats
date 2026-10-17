"use client";

/**
 * Recharts views of a session.
 *
 * The speed profile is the workhorse: speed, upwind VMG and the along-wind component share one time
 * axis so a stretch can be read at a glance, with true wind angle as a faint over-plot on a second
 * axis. VMG is an upwind measure and is only ever named as such; the downwind series is the part of
 * the speed that carried the rider *away* from the wind, which is a different quantity and is not
 * called VMG. Wind is drawn separately because it comes from somewhere else (a station or a model)
 * and must not be confused with what the rider did.
 *
 * Every series is time-based, never sample-index based, so a session recorded at 1 Hz and one at
 * 2 Hz look the same.
 */

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { smoothedSpeeds } from "@/lib/metrics";
import {
  convertSpeed,
  formatDuration,
  formatSpeed,
  SPEED_UNIT_LABEL,
  type SpeedUnit,
} from "@/lib/units";
import type { EnrichedPoint, HistogramBucket } from "@/lib/types";

export interface ChartDatum {
  /** index of the underlying track point, so the charts can stay in sync with the map */
  i: number;
  /** seconds since the first point */
  x: number;
  speed: number | null;
  vmgUp: number | null;
  vmgDown: number | null;
  twa: number | null;
  wind: number | null;
  gust: number | null;
}

/** Cap the number of plotted samples so a long session stays smooth, keeping real time spacing. */
function downsample(points: EnrichedPoint[], maxPoints = 1400): number[] {
  const n = points.length;
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const step = n / maxPoints;
  const idx: number[] = [];
  for (let k = 0; k < maxPoints; k++) idx.push(Math.min(n - 1, Math.round(k * step)));
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx;
}

export function buildChartData(points: EnrichedPoint[], maxPoints = 1400): ChartDatum[] {
  if (points.length === 0) return [];
  const t0 = points[0].t;
  // The profile plots the *smoothed* speed, the same quantity the session maximum quotes. Plotting
  // the raw logged speed put a 46 kn GPS spike on a chart whose own headline read "max 23.8 kn,
  // 3 s smoothed" — one session apparently disagreeing with itself — and the spike squashed the
  // real riding into the bottom quarter of the axis.
  const smoothed = smoothedSpeeds(points);
  return downsample(points, maxPoints).map((i) => {
    const p = points[i];
    return {
      i,
      x: (p.t - t0) / 1000,
      speed: smoothed[i],
      vmgUp: p.vmgUpMps,
      vmgDown: p.vmgDownMps,
      twa: p.twa,
      wind: p.windSpeedMps,
      gust: p.windGustMps,
    };
  });
}

const gridStroke = "#ddd9cf";
const axisStroke = "#b5b0a3";

/** Series colours, matched to the segment colours so a line and its label agree. */
const SPEED_COLOR = "#121211";
const VMG_UP_COLOR = "#14a45c";
const WIND_COLOR = "#0f7c7c";
const GUST_COLOR = "#e0763a";

function timeTicks(seconds: number): string {
  return formatDuration(seconds);
}

interface TooltipPayloadItem {
  name?: string;
  value?: number | string | null;
  color?: string;
  dataKey?: string | number;
}

function ChartTooltip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: number | string;
  unit: SpeedUnit;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const x = typeof label === "number" ? label : Number(label);
  return (
    <div className="tooltip-card px-2.5 py-2 text-[0.68rem]">
      <div className="mono mb-1 font-bold tracking-[0.06em] text-ink">
        {Number.isFinite(x) ? formatDuration(x) : ""}
      </div>
      {payload.map((p, k) => (
        <div key={k} className="mono flex items-center justify-between gap-4 leading-5">
          <span className="flex items-center gap-1.5" style={{ color: p.color }}>
            <span className="size-1.5" style={{ backgroundColor: p.color }} />
            {p.name}
          </span>
          <span className="tabular-nums font-bold text-ink">
            {p.dataKey === "twa"
              ? p.value == null
                ? "—"
                : `${Math.round(Number(p.value))}°`
              : `${formatSpeed(p.value as number | null, unit)} ${SPEED_UNIT_LABEL[unit]}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SpeedProfileChart({
  data,
  unit,
  hoverIdx,
  onHoverIdx,
}: {
  data: ChartDatum[];
  unit: SpeedUnit;
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
}) {
  const series = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        speed: d.speed == null ? null : convertSpeed(d.speed, unit),
        vmgUp: d.vmgUp == null ? null : convertSpeed(d.vmgUp, unit),
        vmgDown: d.vmgDown == null ? null : convertSpeed(d.vmgDown, unit),
      })),
    [data, unit],
  );

  const hoverDatum = hoverIdx == null ? null : series.find((d) => d.i === hoverIdx) ?? null;

  if (data.length === 0) {
    return <ChartEmpty label="No track data" />;
  }

  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={series}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          onMouseMove={(state) => {
            const payload = (state as { activePayload?: { payload?: ChartDatum }[] } | undefined)
              ?.activePayload?.[0]?.payload;
            onHoverIdx(payload ? payload.i : null);
          }}
          onMouseLeave={() => onHoverIdx(null)}
        >
          <CartesianGrid stroke={gridStroke} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={timeTicks}
            stroke={axisStroke}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            yAxisId="speed"
            stroke={axisStroke}
            tickLine={false}
            width={46}
            domain={[0, "auto"]}
            tickFormatter={(v: number) => `${Math.round(v)}`}
          />
          <Tooltip content={<ChartTooltip unit={unit} />} />
          <Line
            yAxisId="speed"
            type="monotone"
            dataKey="speed"
            name="Speed"
            stroke={SPEED_COLOR}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          {hoverDatum && hoverDatum.speed != null && (
            <ReferenceDot
              yAxisId="speed"
              x={hoverDatum.x}
              y={hoverDatum.speed}
              r={3.5}
              fill={VMG_UP_COLOR}
              stroke="#faf9f6"
              strokeWidth={1.5}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpeedHistogram({
  buckets,
  unit,
}: {
  buckets: HistogramBucket[];
  unit: SpeedUnit;
}) {
  const data = useMemo(() => {
    const rows = buckets.map((b) => ({
      label: `${convertSpeed(b.fromMps, unit).toFixed(0)}–${convertSpeed(b.toMps, unit).toFixed(0)}`,
      mid: convertSpeed((b.fromMps + b.toMps) / 2, unit),
      time: b.timeS,
    }));
    // Drop the empty buckets at both ends. A speed axis that is a third empty gutter is harder to
    // read than one that starts and stops where the riding did, and the bucket edges still say
    // exactly which band each bar covers.
    let first = -1;
    let last = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].time > 0) {
        if (first < 0) first = i;
        last = i;
      }
    }
    return first < 0 ? [] : rows.slice(first, last + 1);
  }, [buckets, unit]);

  if (data.length === 0) return <ChartEmpty label="No speed distribution" />;

  // Fixed-width buckets of 0.5 m/s make a long, thin axis: label every few bars so the values stay
  // readable instead of colliding.
  const labelInterval = Math.max(0, Math.ceil(data.length / 8) - 1);

  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={gridStroke} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="label"
            stroke={axisStroke}
            tickLine={false}
            interval={labelInterval}
            angle={-40}
            height={46}
            textAnchor="end"
            tick={{ fontSize: 10 }}
          />
          <YAxis
            stroke={axisStroke}
            tickLine={false}
            width={48}
            tickFormatter={(v: number) => formatDuration(v)}
          />
          <Tooltip
            cursor={{ fill: "#e7e3da", opacity: 0.8 }}
            formatter={(v) => [formatDuration(Number(v ?? 0)), "time"]}
            labelFormatter={(label) => `${label} ${SPEED_UNIT_LABEL[unit]}`}
            contentStyle={{
              background: "#faf9f6",
              border: "1px solid #121211",
              borderRadius: 2,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
            labelStyle={{ color: "#4b4944" }}
          />
          <Bar dataKey="time" radius={[1, 1, 0, 0]}>
            {data.map((d, k) => (
              <Cell key={k} fill={d.mid >= convertSpeed(6, unit) ? GUST_COLOR : VMG_UP_COLOR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function WindChart({
  data,
  unit,
}: {
  data: ChartDatum[];
  unit: SpeedUnit;
}) {
  const series = useMemo(
    () =>
      data
        .filter((d) => d.wind != null || d.gust != null)
        .map((d) => ({
          x: d.x,
          wind: d.wind == null ? null : convertSpeed(d.wind, unit),
          gust: d.gust == null ? null : convertSpeed(d.gust, unit),
        })),
    [data, unit],
  );

  if (series.length === 0) return <ChartEmpty label="No wind data for this session" />;

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={gridStroke} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={timeTicks}
            stroke={axisStroke}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis stroke={axisStroke} tickLine={false} width={44} />
          <Tooltip content={<ChartTooltip unit={unit} />} />
          <Line
            type="stepAfter"
            dataKey="wind"
            name="Wind speed"
            stroke={WIND_COLOR}
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="stepAfter"
            dataKey="gust"
            name="Gusts"
            stroke={GUST_COLOR}
            strokeWidth={1.4}
            strokeDasharray="3 3"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartEmpty({ label }: { label: string }) {
  return (
    <div className="grid h-40 place-items-center border border-dashed border-rule text-[0.72rem] text-grey">
      {label}
    </div>
  );
}
