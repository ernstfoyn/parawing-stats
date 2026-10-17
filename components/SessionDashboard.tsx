"use client";

/**
 * Session dashboard.
 *
 * One place that owns the editable half of a session (name, wind, segment plan, equipment) and
 * re-runs the pure analysis pipeline whenever any of it changes. Because `analyse()` is pure, a
 * relabel or a wind change recalculates the map, the charts, the run lists, the best windows and
 * every statistic in one pass — no re-parsing, no network, no flicker.
 *
 * The panels are ordered by what the rider is actually here to find out: the track and the two
 * run lists first, then how far and how long they went downwind, and only then the wind, the
 * session totals, the charts, the segment editor and the paperwork.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bestEfforts } from "@/lib/bestWindows";
import { carryManualLabels } from "@/lib/classify";
import { analyse } from "@/lib/pipeline";
import {
  DEFAULT_EQUIPMENT_PRESETS,
  saveEquipmentPresets,
  sessionCentroid,
  updateSessionMeta,
} from "@/lib/storage/sessions";
import { describeVmgBasis, downwindRuns, upwindRuns } from "@/lib/summary";
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
import EquipmentPanel from "./EquipmentPanel";
import MapView from "./MapView";
import RunDetail from "./RunDetail";
import RunsTable from "./RunsTable";
import SegmentTimeline from "./SegmentTimeline";
import SpeedBands from "./SpeedBands";
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

  /* The two lists the rider works from, and the numbering the map badges reuse. */
  const dwRuns = useMemo(
    () => downwindRuns(analysis.plan.segments, analysis.points),
    [analysis.plan, analysis.points],
  );
  const uwRuns = useMemo(
    () => upwindRuns(analysis.plan.segments, analysis.points),
    [analysis.plan, analysis.points],
  );
  const dwRanges = useMemo(
    () => dwRuns.map((r) => ({ startIdx: r.segment.startIdx, endIdx: r.segment.endIdx })),
    [dwRuns],
  );

  /** Numbered badge of the longest run is marked passively on load; only a click dims the rest. */
  const highlightId = analysis.dw.downwind.longest?.id ?? null;

  const vmgBasis = useMemo(() => describeVmgBasis(wind, analysis.wind), [wind, analysis.wind]);

  /* The selected stretch, and the chronological order to step through with ← / →. */
  const selectedRun = useMemo(() => {
    const dw = dwRuns.find((r) => r.segment.id === selectedId);
    if (dw) return dw;
    const uw = uwRuns.find((r) => r.segment.id === selectedId);
    if (uw) return uw;
    return null;
  }, [dwRuns, uwRuns, selectedId]);

  const runOrder = useMemo(
    () =>
      [
        ...dwRuns.map((r) => ({ id: r.segment.id, startIdx: r.segment.startIdx })),
        ...uwRuns.map((r) => ({ id: r.segment.id, startIdx: r.segment.startIdx })),
      ].sort((a, b) => a.startIdx - b.startIdx),
    [dwRuns, uwRuns],
  );

  const selectedIndex = useMemo(
    () => runOrder.findIndex((r) => r.id === selectedId),
    [runOrder, selectedId],
  );

  const stepRun = useCallback(
    (delta: -1 | 1) => {
      const next = selectedIndex + delta;
      if (selectedIndex < 0 || next < 0 || next >= runOrder.length) return;
      setSelectedId(runOrder[next].id);
    },
    [runOrder, selectedIndex],
  );

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

  const dwKr = dw.downwind;
  const runsHint = [
    dwKr.count > 0 ? formatDurationLong(dwKr.durationS) : null,
    dw.poweredReach.count > 0
      ? `${dw.poweredReach.count} powered reach${dw.poweredReach.count === 1 ? "" : "es"} not counted`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

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
        {/* ------------------------------------------------------------------ track */}
        <Panel
          index="01"
          kicker="Track"
          title="Where the session went"
          subtitle="One thin solid line per stretch, coloured by label. Click a run in either list to zoom to it, drop the rest of the track back to grey, and open that stretch up slice by slice."
        >
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
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

            <div className="flex flex-col gap-5 lg:max-h-[62vh] lg:overflow-y-auto lg:pr-2">
              <section>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <div className="label">Downwind runs</div>
                  <span className="mono text-[0.6rem] text-grey">
                    {dwRuns.length} · {formatDistance(dwKr.distanceM, 3)}
                  </span>
                </div>
                <RunsTable
                  kind="downwind"
                  points={analysis.points}
                  plan={analysis.plan}
                  unit={unit}
                  tzOffsetMin={tz}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  compact
                />
              </section>

              <section>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <div className="label">Upwind · speed &amp; VMG</div>
                  <span className="mono text-[0.6rem] text-grey">
                    {uwRuns.length} · {formatDistance(analysis.upwind.distanceM, 3)}
                  </span>
                </div>
                <RunsTable
                  kind="upwind"
                  points={analysis.points}
                  plan={analysis.plan}
                  unit={unit}
                  tzOffsetMin={tz}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  compact
                />
              </section>
            </div>
          </div>

          <p className="mt-3 text-[0.68rem] leading-relaxed text-grey">{vmgBasis}</p>

          {selectedRun && (
            <RunDetail
              points={analysis.points}
              segment={selectedRun.segment}
              unit={unit}
              tzOffsetMin={tz}
              ordinal={selectedRun.n}
              onClear={() => setSelectedId(null)}
              onStep={stepRun}
              canStepBack={selectedIndex > 0}
              canStepForward={selectedIndex >= 0 && selectedIndex < runOrder.length - 1}
            />
          )}
        </Panel>

        {/* -------------------------------------------------------------- downwind */}
        <Panel
          index="02"
          kicker="Downwind"
          title="How far, and how long, going downwind"
          subtitle="A stretch counts as a downwind run when it ran within 55° of straight downwind. That is too deep to hold with the parawing still flying, so these are the runs on wave energy — and every one of them is a candidate until you confirm it."
        >
          {dwKr.count === 0 ? (
            <div className="space-y-3">
              <p className="text-[0.76rem] leading-relaxed text-grey">
                No stretch on this track ran deep enough to count as a downwind run yet, so there is
                no distance or time to report. Label a block in the segment timeline below and the
                numbers appear immediately.
              </p>
              {dw.poweredReach.count > 0 && (
                <Note>
                  {dw.poweredReach.count} stretch
                  {dw.poweredReach.count === 1 ? "" : "es"} ({formatDistance(dw.poweredReach.distanceM, 3)},{" "}
                  {formatDuration(dw.poweredReach.durationS)}) were powered reaches — the wing still
                  flying, the course only just past the beam. They are deliberately not counted as
                  downwind.
                </Note>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
                <Stat
                  label="Downwind distance"
                  value={formatDistance(dwKr.distanceM)}
                  accent="familiar"
                />
                <Stat
                  label="Downwind time"
                  value={formatDuration(dwKr.durationS)}
                  hint={formatDurationLong(dwKr.durationS)}
                />
                <Stat
                  label="Runs"
                  value={dwKr.count}
                  accent="familiar"
                  hint={runsHint || undefined}
                />
                <Stat
                  label="Avg speed"
                  value={formatSpeed(dwKr.avgSpeedMps, unit)}
                  unit={SPEED_UNIT_LABEL[unit]}
                  hint="over the runs only"
                />
              </div>

              <div className="mt-5 border-t border-quiet pt-4">
                <SpeedBands points={analysis.points} ranges={dwRanges} unit={unit} />
              </div>

              <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-quiet pt-4 sm:grid-cols-3 lg:grid-cols-6">
                <Stat
                  label="Max speed"
                  value={formatSpeed(dwKr.maxSpeedMps, unit)}
                  unit={SPEED_UNIT_LABEL[unit]}
                />
                <Stat
                  label="Avg DW VMG"
                  value={formatSpeed(dwKr.avgVmgDownMps, unit)}
                  unit={SPEED_UNIT_LABEL[unit]}
                  hint="away from the wind"
                />
                <Stat
                  label="Longest run"
                  value={formatDistance(dwKr.longest?.distanceM ?? 0)}
                  hint={dwKr.longest ? formatDuration(dwKr.longest.durationS) : undefined}
                />
                <Stat
                  label="Longest run max"
                  value={formatSpeed(dwKr.longest?.maxSpeedMps ?? null, unit)}
                  unit={SPEED_UNIT_LABEL[unit]}
                  small
                />
                <Stat
                  label="Powered reaches"
                  value={dw.poweredReach.count}
                  accent="origin"
                  small
                  hint={
                    dw.poweredReach.count > 0
                      ? `${formatDistance(dw.poweredReach.distanceM, 3)} — not counted as downwind`
                      : "none on this track"
                  }
                />
                <Stat
                  label="Deepest run"
                  value={`${Math.round(
                    Math.max(...dwRuns.map((r) => r.segment.features.avgTwaDeg), 0),
                  )}°`}
                  small
                  hint="mean TWA; 180° is straight downwind"
                />
              </div>

              <div className="mt-4">
                <Note>
                  Downwind distance and time count the runs only. A powered reach is a stretch you
                  were still flying through with the course barely past the beam — it is reported
                  separately and never added in, because a parawing cannot hold a run with the wing
                  up, so a powered stretch is not a downwind one.
                </Note>
              </div>
            </>
          )}
        </Panel>

        {/* ------------------------------------------------------------------ wind */}
        <Panel
          index="03"
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

        {/* --------------------------------------------------------------- session */}
        <Panel
          index="04"
          kicker="Session"
          title="What the session added up to"
          subtitle="All averages are time-weighted over the real timestamps, never over sample counts. Heading time counts every second spent on that point of sail, transitions included; the Downwind panel above counts only complete runs."
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
              label="Upwind heading time"
              value={formatDuration(analysis.upwind.timeS)}
              accent="signal"
              hint={`${formatDistance(analysis.upwind.distanceM)} at TWA ≤ 70°`}
            />
            <Stat
              label="Downwind heading time"
              value={formatDuration(analysis.downwind.timeS)}
              accent="familiar"
              hint={`${formatDistance(analysis.downwind.distanceM)} at TWA ≥ 110°`}
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

        {/* ---------------------------------------------------------- best efforts */}
        <Panel
          index="05"
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

        {/* -------------------------------------------------------------- timeline */}
        <Panel
          index="07"
          kicker="Segments"
          title="Every block of the session"
          subtitle="The whole session as a timeline — this is where a label gets corrected. Click a block to edit it; the classifier's estimate stays open until you decide."
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
      index="09"
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
