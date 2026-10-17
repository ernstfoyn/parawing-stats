"use client";

/**
 * Session dashboard.
 *
 * One place that owns the editable half of a session (name, wind, segment plan, equipment) and
 * re-runs the pure analysis pipeline whenever any of it changes. Because `analyse()` is pure, a
 * relabel or a wind change recalculates the map, the charts, the runs table, the best windows and
 * every statistic in one pass — no re-parsing, no network, no flicker.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bestEfforts } from "@/lib/bestWindows";
import { analyse } from "@/lib/pipeline";
import { carryManualLabels } from "@/lib/classify";
import {
  DEFAULT_EQUIPMENT_PRESETS,
  saveEquipmentPresets,
  sessionCentroid,
  updateSessionMeta,
} from "@/lib/storage/sessions";
import {
  formatDateInOffset,
  formatDistance,
  formatDuration,
  formatDurationLong,
  formatOffset,
  formatSpeed,
  SPEED_UNIT_LABEL,
  type SpeedUnit,
} from "@/lib/units";
import type { EnrichedPoint, EquipmentProfile, SessionRecord, WindModel, WindSample } from "@/lib/types";
import BestWindows from "./BestWindows";
import { buildChartData, SpeedHistogram, SpeedProfileChart, WindChart } from "./Charts";
import DownwindRuns from "./DownwindRuns";
import EquipmentPanel from "./EquipmentPanel";
import MapView from "./MapView";
import SegmentTimeline from "./SegmentTimeline";
import WindPanel from "./WindPanel";
import { Chip, Note, Panel, SegmentedControl, Stat } from "./ui";

const UNIT_KEY = "foil-analyzer:speed-unit";

function readStoredUnit(): SpeedUnit {
  if (typeof window === "undefined") return "kn";
  try {
    const stored = globalThis.localStorage?.getItem(UNIT_KEY);
    return stored === "mps" || stored === "kmh" ? stored : "kn";
  } catch {
    return "kn";
  }
}

export default function SessionDashboard({
  record,
  initialPresets,
}: {
  record: SessionRecord;
  initialPresets: EquipmentProfile[];
}) {
  const [unit, setUnit] = useState<SpeedUnit>(readStoredUnit);
  const [name, setName] = useState(record.name);
  const [wind, setWind] = useState<WindModel>(record.wind);
  const [windSamples, setWindSamples] = useState<WindSample[]>(record.windSamples);
  const [plan, setPlan] = useState(record.segments);
  const [equipment, setEquipment] = useState<EquipmentProfile>(record.equipment);
  const [presets, setPresets] = useState<EquipmentProfile[]>(
    initialPresets.length > 0 ? initialPresets : DEFAULT_EQUIPMENT_PRESETS,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const changeUnit = (u: SpeedUnit) => {
    setUnit(u);
    try {
      globalThis.localStorage?.setItem(UNIT_KEY, u);
    } catch {
      /* storage might be unavailable; the in-memory unit still works */
    }
  };

  /* --------------------------------------------------------------- analysis */

  const analysis = useMemo(
    () => analyse({ points: record.points, windSamples, windModel: wind, plan }),
    [record.points, windSamples, wind, plan],
  );

  const chartData = useMemo(() => buildChartData(analysis.points), [analysis.points]);
  const efforts = useMemo(() => bestEfforts(analysis.points), [analysis.points]);
  const centroid = useMemo(() => sessionCentroid(record.points), [record.points]);
  const highlightId = analysis.dw.all.longest?.id ?? null;

  /* When the wind changes, rebuild the automatic classification (the old guesses used different
     wind) but keep every label the rider confirmed. */
  const windKey = useMemo(() => `${wind.kind}|${wind.station?.id ?? ""}|${windSamples.length}|${wind.manual?.speedMps ?? ""}|${wind.manual?.dirFromDeg ?? ""}`, [wind, windSamples]);
  const lastWindKey = useRef(windKey);
  useEffect(() => {
    if (lastWindKey.current === windKey) return;
    lastWindKey.current = windKey;
    setPlan((prev) => {
      const fresh = analyse({
        points: record.points,
        windSamples,
        windModel: wind,
        rebuildSegments: true,
      });
      return carryManualLabels(prev, fresh.plan);
    });
  }, [windKey, record.points, windSamples, wind]);

  /* ----------------------------------------------------------------- persist */

  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const next: SessionRecord = {
      ...record,
      name,
      wind,
      windSamples,
      segments: plan,
      equipment,
    };
    const handle = setTimeout(() => {
      void updateSessionMeta(next);
    }, 400);
    return () => clearTimeout(handle);
  }, [record, name, wind, windSamples, plan, equipment]);

  const onWindChange = useCallback(
    (nextWind: WindModel, nextSamples: WindSample[]) => {
      setWind(nextWind);
      setWindSamples(nextSamples);
    },
    [],
  );

  const onSavePreset = useCallback(async (preset: EquipmentProfile) => {
    const id = preset.id || `preset-${Math.random().toString(36).slice(2, 9)}`;
    const next = [...presets.filter((p) => p.id !== id), { ...preset, id }];
    setPresets(next);
    await saveEquipmentPresets(next);
  }, [presets]);

  const onDeletePreset = useCallback(async (id: string) => {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    await saveEquipmentPresets(next);
  }, [presets]);

  /* ---------------------------------------------------------------- render */

  const m = analysis.metrics;
  const dw = analysis.dw;
  const tz = record.timezoneOffsetMin;
  const localTime = (t: number) =>
    new Date(t + (tz ?? 0) * 60_000).toISOString().slice(11, 16);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      {/* ---------------------------------------------------------------- header */}
      <header className="mb-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <Link
              href="/"
              className="mono text-[0.62rem] uppercase tracking-[0.14em] text-grey hover:text-ink"
            >
              ← All sessions
            </Link>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <textarea
                value={name}
                rows={1}
                cols={60}
                onChange={(e) => setName(e.target.value)}
                aria-label="Session name"
                className="session-name min-w-0 border-b border-transparent bg-transparent pb-1 text-xl font-semibold leading-tight tracking-tight text-ink hover:border-rule focus:border-ink focus:outline-none sm:text-3xl"
              />
              {record.demo && (
                <Chip color="#e0763a" title="Synthetic data generated by the app, not a real session.">
                  demo · synthetic
                </Chip>
              )}
            </div>
            <p className="mono mt-2 text-[0.66rem] uppercase tracking-[0.08em] text-grey">
              {formatDateInOffset(record.startedAt, tz)}
              <span className="mx-1.5 text-quiet">•</span>
              {localTime(record.startedAt)}–{localTime(record.endedAt)} ({formatOffset(tz)})
              <span className="mx-1.5 text-quiet">•</span>
              {[record.sport, record.device].filter(Boolean).join(" · ") || "unknown device"}
            </p>
          </div>
          <div className="ml-auto">
            <SegmentedControl
              ariaLabel="Speed unit"
              value={unit}
              onChange={changeUnit}
              options={[
                { value: "kn", label: "knots" },
                { value: "mps", label: "m/s" },
                { value: "kmh", label: "km/h" },
              ]}
            />
          </div>
        </div>
      </header>

      <div className="space-y-4">
        {/* ------------------------------------------------------------------ wind */}
        <Panel
          index="01"
          kicker="Wind"
          title="Where the wind came from"
          subtitle="Wind is estimated at your position from a station or a model — it is never a measurement of the conditions you rode in."
        >
          <WindPanel
            startedAt={record.startedAt}
            endedAt={record.endedAt}
            centroid={centroid}
            wind={wind}
            windSamples={windSamples}
            summary={analysis.wind}
            unit={unit}
            onChange={onWindChange}
          />
        </Panel>

        {/* ------------------------------------------------------------------- map */}
        <Panel
          index="02"
          kicker="Track"
          title="GPS track"
          subtitle="Coloured by segment. Dashed lines are classifier estimates; solid lines are labels you confirmed. Numbered badges are the downwind runs in the table below."
        >
          <MapView
            points={analysis.points}
            labels={analysis.labels}
            plan={analysis.plan}
            highlightId={highlightId}
            selectedId={selectedId}
            onSelect={setSelectedId}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            unit={unit}
            tzOffsetMin={tz}
            wind={
              wind.kind === "none"
                ? null
                : {
                    dirFromDeg: wind.manual?.dirFromDeg ?? analysis.wind.meanDirFromDeg,
                    speedMps: wind.manual?.speedMps ?? analysis.wind.avgSpeedMps,
                    quality: wind.kind === "manual" ? "manual" : null,
                  }
            }
          />
        </Panel>

        {/* --------------------------------------------------------------- metrics */}
        <Panel
          index="03"
          kicker="Session"
          title="What the session added up to"
          subtitle="All averages are time-weighted over the real timestamps, never over sample counts."
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
            <Stat label="Distance" value={formatDistance(m.distanceM)} />
            <Stat label="Moving time" value={formatDuration(m.movingTimeS)} hint={formatDurationLong(m.movingTimeS)} />
            <Stat label="Elapsed" value={formatDuration(m.elapsedTimeS)} hint="including stops" />
            <Stat
              label="Avg speed"
              value={formatSpeed(m.avgSpeedMps, unit)}
              unit={SPEED_UNIT_LABEL[unit]}
              hint="over moving time"
            />
            <Stat
              label="Max speed"
              value={formatSpeed(m.maxSpeedMps, unit)}
              unit={SPEED_UNIT_LABEL[unit]}
              accent="origin"
              hint="3 s smoothed"
            />
            <Stat
              label="Upwind time"
              value={formatDuration(analysis.upwind.timeS)}
              accent="signal"
              hint={formatDistance(analysis.upwind.distanceM)}
            />
            <Stat
              label="Downwind time"
              value={formatDuration(analysis.downwind.timeS)}
              accent="origin"
              hint={formatDistance(analysis.downwind.distanceM)}
            />
            <Stat
              label="Avg VMG up / down"
              value={`${formatSpeed(analysis.upwind.avgVmgMps, unit)} / ${formatSpeed(analysis.downwind.avgVmgMps, unit)}`}
              unit={SPEED_UNIT_LABEL[unit]}
              small
              hint="positive toward / away from the wind"
            />
          </div>
          {wind.kind === "none" && (
            <div className="mt-4">
              <Note tone="warn">
                No wind data is set, so TWA, VMG and the downwind classification are unavailable.
                Add a wind source above to unlock them. Nothing has been assumed in the meantime.
              </Note>
            </div>
          )}
        </Panel>

        {/* ----------------------------------------------------------- downwind stats */}
        <Panel
          index="04"
          kicker="Downwind"
          title="Wave runs"
          subtitle="Only segments you have confirmed as downwind count in the totals. The classifier's guesses are listed below and dashed on the map, but never counted."
        >
          {dw.all.count === 0 ? (
            <p className="text-[0.76rem] text-grey">
              No downwind segments on this track yet, confirmed or guessed. Label a block in the
              segment timeline below and the numbers appear immediately.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Downwind segments" value={dw.all.count} accent="origin" />
              <Stat label="Total distance" value={formatDistance(dw.all.distanceM)} accent="origin" />
              <Stat label="Time" value={formatDuration(dw.all.durationS)} />
              <Stat
                label="Avg speed"
                value={formatSpeed(dw.all.avgSpeedMps, unit)}
                unit={SPEED_UNIT_LABEL[unit]}
              />
              <Stat
                label="Max speed"
                value={formatSpeed(dw.all.maxSpeedMps, unit)}
                unit={SPEED_UNIT_LABEL[unit]}
              />
              <Stat
                label="Avg DW VMG"
                value={formatSpeed(dw.all.avgVmgDownMps, unit)}
                unit={SPEED_UNIT_LABEL[unit]}
              />
              <Stat
                label="Longest run"
                value={formatDistance(dw.all.longest?.distanceM ?? 0)}
                hint={dw.all.longest ? formatDuration(dw.all.longest.durationS) : undefined}
              />
              <Stat label="Free (packed wing)" value={dw.free.count} accent="familiar" hint={formatDistance(dw.free.distanceM)} />
              <Stat label="Powered" value={dw.powered.count} accent="origin" hint={formatDistance(dw.powered.distanceM)} />
              <Stat
                label="Longest run max"
                value={formatSpeed(dw.all.longest?.maxSpeedMps ?? null, unit)}
                unit={SPEED_UNIT_LABEL[unit]}
                small
              />
              <Stat
                label="Free avg speed"
                value={dw.free.count > 0 ? formatSpeed(dw.free.avgSpeedMps, unit) : "—"}
                unit={dw.free.count > 0 ? SPEED_UNIT_LABEL[unit] : undefined}
                small
              />
              <Stat
                label="Powered avg speed"
                value={dw.powered.count > 0 ? formatSpeed(dw.powered.avgSpeedMps, unit) : "—"}
                unit={dw.powered.count > 0 ? SPEED_UNIT_LABEL[unit] : undefined}
                small
              />
            </div>
          )}
        </Panel>

        {/* ------------------------------------------------------------- runs table */}
        <Panel
          index="05"
          kicker="Runs"
          title="Every downwind run"
          subtitle="Click a row to open that run on the map. Speed is stated in your unit and in m/s, because the two get mixed up constantly."
        >
          <DownwindRuns
            points={analysis.points}
            plan={analysis.plan}
            unit={unit}
            tzOffsetMin={tz}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </Panel>

        {/* ---------------------------------------------------------------- charts */}
        <Panel
          index="06"
          kicker="Speed & VMG"
          title="The session as a curve"
          subtitle="One time axis: speed, upwind VMG (toward the wind) and downwind VMG (away), with true wind angle faint behind."
        >
          <SpeedProfileChart
            data={chartData}
            unit={unit}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
          />
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <div>
              <div className="label">Time at speed</div>
              <SpeedHistogram buckets={m.speedBuckets} unit={unit} />
            </div>
            <div>
              <div className="label">Wind over the session</div>
              <WindChart data={chartData} unit={unit} />
            </div>
          </div>
        </Panel>

        {/* ---------------------------------------------------------- best efforts */}
        <Panel
          index="07"
          kicker="Best efforts"
          title="Best windows"
          subtitle="The fastest one, two and three minute windows, and the best VMG in each. Bars are comparable down a column."
        >
          <BestWindows
            windows={efforts}
            unit={unit}
            tzOffsetMin={tz}
            reference={{
              speed: m.avgSpeedMps,
              vmgUp: analysis.upwind.avgVmgMps,
              vmgDown: analysis.downwind.avgVmgMps,
            }}
          />
        </Panel>

        {/* -------------------------------------------------------------- timeline */}
        <Panel
          index="08"
          kicker="Segments"
          title="Every block of the session"
          subtitle="The whole session as a timeline. Click a block to edit it; the classifier's estimate is faded until you decide."
        >
          <SegmentTimeline
            points={analysis.points}
            plan={analysis.plan}
            selectedId={selectedId}
            onSelect={setSelectedId}
            highlightId={highlightId}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            onPlanChange={setPlan}
            tzOffsetMin={tz}
            unit={unit}
          />
        </Panel>

        {/* ------------------------------------------------------------- equipment */}
        <EquipmentPanel
          equipment={equipment}
          presets={presets}
          onChange={setEquipment}
          onSavePreset={onSavePreset}
          onDeletePreset={onDeletePreset}
        />

        {/* ----------------------------------------------------------- data quality */}
        <DataQuality record={record} points={analysis.points} />
      </div>
    </div>
  );
}

function DataQuality({ record, points }: { record: SessionRecord; points: EnrichedPoint[] }) {
  const r = record.cleanup;
  const dropped =
    r.droppedInvalidPosition +
    r.droppedDuplicateTimestamp +
    r.droppedSpeedSpike +
    r.droppedOutOfOrder +
    r.droppedPaused;

  return (
    <Panel
      index="10"
      kicker="Data quality"
      title="What the importer kept and threw away"
      subtitle="Nothing is filled in or interpolated into existence."
    >
      <div className="flex flex-wrap gap-1.5">
        <Chip>
          {r.kept} of {r.totalRaw} fixes kept
        </Chip>
        {dropped > 0 && <Chip color="#e0763a">{dropped} discarded</Chip>}
        {r.gaps > 0 && (
          <Chip color="#e0763a">
            {r.gaps} gap(s), longest {Math.round(r.longestGapS)} s
          </Chip>
        )}
        <Chip>{formatOffset(r.timezoneOffsetMin)}</Chip>
        <Chip>{record.fileName}</Chip>
        <Chip>app {record.appVersion}</Chip>
        <Chip>{points.length} points analysed</Chip>
      </div>

      <details className="group mt-3">
        <summary className="mono cursor-pointer text-[0.66rem] uppercase tracking-[0.08em] text-grey hover:text-ink">
          Show importer notes ({record.rawWarnings.length + r.notes.length})
        </summary>
        <ul className="mt-2 space-y-1 text-[0.7rem] leading-relaxed text-grey">
          {[...record.rawWarnings, ...r.notes].map((n, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-quiet">•</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      </details>
    </Panel>
  );
}
