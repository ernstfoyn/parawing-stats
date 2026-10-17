"use client";

/**
 * Session dashboard.
 *
 * One place that owns the editable half of a session (name, wind, segment plan, equipment) and
 * re-runs the pure analysis pipeline whenever any of it changes. Because `analyse()` is pure, a
 * relabel or a wind change recalculates the map, the chart, the segment blocks and every statistic
 * in one pass — no re-parsing, no network, no flicker.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { buildChartData, SpeedHistogram, SpeedProfileChart, WindChart } from "./Charts";
import EquipmentPanel from "./EquipmentPanel";
import MapView from "./MapView";
import SegmentTimeline from "./SegmentTimeline";
import WindPanel from "./WindPanel";
import { Chip, Panel, SegmentedControl, Stat } from "./ui";

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

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-6">
      {/* ---------------------------------------------------------------- header */}
      <header className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href="/" className="text-[0.72rem] text-fog hover:text-mist">
              ← All sessions
            </Link>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Session name"
                className="min-w-0 max-w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-xl font-semibold tracking-tight text-snow hover:border-line focus:border-accent focus:outline-none"
              />
              {record.demo && (
                <Chip color="#f59e0b" title="Synthetic data generated by the app, not a real session.">
                  demo · synthetic data
                </Chip>
              )}
            </div>
            <p className="mt-1 text-xs text-fog">
              {formatDateInOffset(record.startedAt, record.timezoneOffsetMin)} ·{" "}
              {new Date(record.startedAt + (record.timezoneOffsetMin ?? 0) * 60_000).toISOString().slice(11, 16)}
              –{new Date(record.endedAt + (record.timezoneOffsetMin ?? 0) * 60_000).toISOString().slice(11, 16)}{" "}
              ({formatOffset(record.timezoneOffsetMin)}) ·{" "}
              {[record.sport, record.device].filter(Boolean).join(" · ") || "unknown device"}
            </p>
          </div>
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
      </header>

      <div className="space-y-5">
        {/* ------------------------------------------------------------------ wind */}
        <Panel
          title="Wind"
          subtitle="Where the wind numbers come from. Wind is estimated at your position from a station or a model — it is never a measurement of the conditions you rode in."
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
          title="Track"
          subtitle="Coloured by segment. Dashed lines are classifier estimates; solid lines are confirmed labels."
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
            tzOffsetMin={record.timezoneOffsetMin}
            wind={
              wind.kind === "none"
                ? null
                : {
                    dirFromDeg:
                      wind.manual?.dirFromDeg ?? analysis.wind.meanDirFromDeg,
                    speedMps: wind.manual?.speedMps ?? analysis.wind.avgSpeedMps,
                    quality: wind.kind === "manual" ? "manual" : null,
                  }
            }
          />
        </Panel>

        {/* --------------------------------------------------------------- metrics */}
        <Panel title="Session" subtitle="All averages are time-weighted over the real timestamps.">
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
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
              accent="ember"
              hint="3 s smoothed"
            />
            <Stat
              label="Upwind time"
              value={formatDuration(analysis.upwind.timeS)}
              accent="sky"
              hint={formatDistance(analysis.upwind.distanceM)}
            />
            <Stat
              label="Downwind time"
              value={formatDuration(analysis.downwind.timeS)}
              accent="ember"
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
            <p className="mt-4 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 text-[0.72rem] leading-relaxed text-amber">
              No wind data is set, so TWA, VMG and the downwind classification are unavailable. Add a
              wind source above to unlock them. Nothing has been assumed in the meantime.
            </p>
          )}
        </Panel>

        {/* ----------------------------------------------------------- downwind stats */}
        <Panel
          title="Downwind"
          subtitle="Only segments you have confirmed as downwind count here. The classifier's guesses are shown on the map but never in these numbers."
        >
          {dw.all.count === 0 ? (
            <p className="text-xs text-fog">
              No confirmed downwind segments yet. Zoom the map, find the runs, and label them in the
              timeline below — the numbers appear immediately.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Downwind segments" value={dw.all.count} accent="ember" />
              <Stat label="Total distance" value={formatDistance(dw.all.distanceM)} accent="ember" />
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
              <Stat label="Free (packed wing)" value={dw.free.count} accent="ember" hint={formatDistance(dw.free.distanceM)} />
              <Stat label="Powered" value={dw.powered.count} hint={formatDistance(dw.powered.distanceM)} />
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

        {/* ---------------------------------------------------------------- charts */}
        <Panel
          title="Speed & VMG"
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

        {/* -------------------------------------------------------------- timeline */}
        <Panel
          title="Segments"
          subtitle="The whole session as a timeline. Click a block to edit it; the classifier's estimate is shown faded until you decide."
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
            tzOffsetMin={record.timezoneOffsetMin}
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
      title="Data quality"
      subtitle="What the importer kept, changed and threw away. Nothing is filled in or interpolated into existence."
    >
      <div className="flex flex-wrap gap-1.5">
        <Chip>{r.kept} of {r.totalRaw} fixes kept</Chip>
        {dropped > 0 && <Chip color="#f59e0b">{dropped} discarded</Chip>}
        {r.gaps > 0 && <Chip color="#f59e0b">{r.gaps} gap(s), longest {Math.round(r.longestGapS)} s</Chip>}
        <Chip>{formatOffset(r.timezoneOffsetMin)}</Chip>
        <Chip>{record.fileName}</Chip>
        <Chip>app {record.appVersion}</Chip>
        <Chip>{points.length} points analysed</Chip>
      </div>

      <details className="group mt-3">
        <summary className="cursor-pointer text-xs text-fog hover:text-mist">
          Show importer notes ({record.rawWarnings.length + r.notes.length})
        </summary>
        <ul className="mt-2 space-y-1 text-[0.72rem] leading-relaxed text-fog">
          {[...record.rawWarnings, ...r.notes].map((n, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-line">•</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      </details>
    </Panel>
  );
}
