"use client";

/**
 * Session dashboard.
 *
 * One place that owns the editable half of a session (name, wind, segment plan, equipment) and
 * re-runs the pure analysis pipeline whenever any of it changes. Because `analyse()` is pure, a
 * relabel or a wind change recalculates the map, the charts, the run lists, the best windows and
 * every statistic in one pass — no re-parsing, no network, no flicker.
 *
 * The panels are ordered by what the rider is actually here to find out: the session and the
 * downwind headline first, then the map with its two run lists, then the wind that every one of
 * those numbers is measured against, then the supporting views, the segment editor and the
 * paperwork. A rider trimmed this order twice, so it is not arbitrary: the numbers, then where they
 * happened, then where the wind came from.
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
import { speedBandsInRanges } from "@/lib/metrics";
import { describeVmgBasis, downwindRuns, upwindRuns } from "@/lib/summary";
import {
  formatBandEdge,
  formatDateInOffset,
  formatDistance,
  formatDuration,
  formatDurationLong,
  formatOffset,
  formatSpeed,
  formatTimeInOffset,
  SPEED_UNIT_LABEL,
  speedBandSpec,
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
import WindPanel from "./WindPanel";
import { Chip, Note, Panel, SegmentedControl, Stat } from "./ui";

/** A storage key, not the product name — see the note on DB_NAME in lib/storage/db.ts. */
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

  /** Without a wind direction there is no upwind and no downwind, so nothing can be classified. */
  const needsWind = wind.kind === "none";

  /**
   * The single band where most of the downwind time went. This is the one number that answers "how
   * long at which speed" without a whole panel of histogram and table: the banding is the same
   * exact, time-weighted walk over the runs, so it can never disagree with them.
   */
  const peakBand = useMemo(() => {
    if (dwRanges.length === 0) return null;
    const spec = speedBandSpec(unit);
    const bands = speedBandsInRanges(analysis.points, dwRanges, spec.widthMps, spec.maxMps);
    let best: (typeof bands)[number] | null = null;
    for (const b of bands) if (b.timeS > 0 && (best == null || b.timeS > best.timeS)) best = b;
    return best;
  }, [analysis.points, dwRanges, unit]);

  /**
   * Send the rider to the one thing that is missing. The wind panel searches for stations on its
   * own, so by the time the scroll lands there the candidates are already listed.
   */
  const goToWind = useCallback(() => {
    globalThis.document?.getElementById("panel-wind")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, []);

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
  /**
   * Session clock. `formatTimeInOffset` resolves a missing offset the way the label promises —
   * as the browser's own offset — instead of silently showing UTC and calling it local time.
   */
  const localTime = (t: number) => formatTimeInOffset(t, tz);

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
        {/* --------------------------------------------------------------- session */}
        <Panel
          index="01"
          kicker="Session"
          title="The session at a glance"
          subtitle="Every average is time-weighted over the real timestamps, never over sample counts. Heading time counts every second spent on that point of sail, transitions included; downwind distance and time count whole runs only."
        >
          {needsWind && <NeedsWind onFind={goToWind} />}

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
              label="Avg upwind VMG"
              value={formatSpeed(analysis.upwind.avgVmgMps, unit)}
              unit={SPEED_UNIT_LABEL[unit]}
              hint="the part of your speed that went towards the wind"
            />
          </div>

          {/* Downwind headline. VMG is deliberately absent: it is an upwind measure, so a run is
              reported as distance, time and speed, with depth as the evidence for its label. */}
          <div className="mt-5 border-t border-rule pt-4">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <div className="label">Downwind</div>
              <span className="mono text-[0.6rem] text-grey">
                {dwKr.count} run{dwKr.count === 1 ? "" : "s"} ·{" "}
                {formatDistance(dwKr.distanceM, 3)}
              </span>
            </div>
            {needsWind ? (
              <p className="text-[0.76rem] leading-relaxed text-grey">
                Without a wind direction nothing here can be measured — a run and a beat are the same
                stretch of water. Choose a station below and this block fills in.
              </p>
            ) : dwKr.count === 0 ? (
              <p className="text-[0.76rem] leading-relaxed text-grey">
                Wind is set, but no stretch ran deep enough to count as a downwind run, so there is no
                distance or time to report.
                {dw.poweredReach.count > 0 &&
                  ` ${dw.poweredReach.count} powered reach${
                    dw.poweredReach.count === 1 ? "" : "es"
                  } (${formatDistance(dw.poweredReach.distanceM, 3)}) ${
                    dw.poweredReach.count === 1 ? "was" : "were"
                  } found and deliberately not counted.`}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
                <Stat label="Downwind distance" value={formatDistance(dwKr.distanceM)} accent="familiar" />
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
                <Stat
                  label="Max speed"
                  value={formatSpeed(dwKr.maxSpeedMps, unit)}
                  unit={SPEED_UNIT_LABEL[unit]}
                  small
                  hint="in a downwind run"
                />
                <Stat
                  label="Longest run"
                  value={formatDistance(dwKr.longest?.distanceM ?? 0)}
                  small
                  hint={dwKr.longest ? formatDuration(dwKr.longest.durationS) : undefined}
                />
                <Stat
                  label="Deepest run"
                  value={`${Math.round(Math.max(...dwRuns.map((r) => r.segment.features.avgTwaDeg), 0))}°`}
                  small
                  hint="mean TWA; 180° is straight downwind"
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
              </div>
            )}
          </div>

          {!needsWind && dwKr.count > 0 && peakBand && (
            <p className="mt-3 text-[0.72rem] leading-relaxed text-graphite">
              Most of that time went between{" "}
              <span className="mono font-bold text-ink">
                {formatBandEdge(peakBand.fromMps, unit)}–{formatBandEdge(peakBand.toMps, unit)}{" "}
                {SPEED_UNIT_LABEL[unit]}
              </span>{" "}
              — {formatDuration(peakBand.timeS)}, {Math.round(peakBand.share * 100)}% of the downwind
              time.
            </p>
          )}

          {!needsWind && (
            <div className="mt-4">
              <Note>
                Downwind distance and time count the runs only. A powered reach is a stretch you were
                still flying through with the course barely past the beam — it is reported separately
                and never added in, because a parawing cannot hold a run with the wing up, so a powered
                stretch is not a downwind one.
              </Note>
            </div>
          )}
        </Panel>

        {/* ------------------------------------------------------------------ track */}
        <Panel
          index="02"
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
                  needsWind={needsWind}
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
                  needsWind={needsWind}
                  compact
                />
              </section>
            </div>
          </div>

          {!needsWind && <p className="mt-3 text-[0.68rem] leading-relaxed text-grey">{vmgBasis}</p>}
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

        {/* ------------------------------------------------------------------ wind */}
        <Panel
          id="panel-wind"
          index="03"
          kicker="Wind"
          title={needsWind ? "Set the wind — this is what the analysis needs" : "Where the wind came from"}
          subtitle="Every upwind/downwind number in this app is measured against this wind, and it is estimated at your position from a station or a model — never a measurement of the conditions you actually rode in."
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

        {/* ---------------------------------------------------------- best efforts */}
        <Panel
          index="04"
          kicker="Best efforts"
          title="Best windows"
          subtitle="The fastest one, two and three minute windows, with the best upwind VMG and along-wind speed in each. Bars are comparable down a column."
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
          index="05"
          kicker="Speed"
          title="The session as a curve"
          subtitle="Your speed over the whole session on the real time axis. Hover it to see where you were, or read the time-at-speed below, which is the same data as a distribution."
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
          index="06"
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

/**
 * The one thing standing between an imported file and any analysis: a wind direction.
 *
 * Without it there is no upwind and no downwind — the two are the same stretch of water — so every
 * stretch is `unclassified` and every run list is empty. That is the honest state, but wrapped in a
 * bare empty list it reads exactly like a broken analysis, which is what a rider told us. So it is
 * never shown as an empty list: it says what is missing, why it matters, and offers the fix.
 */
function NeedsWind({ onFind }: { onFind: () => void }) {
  return (
    <div className="border border-origin bg-card px-4 py-3">
      <p className="mono text-[0.66rem] uppercase tracking-[0.1em] text-origin">
        Wind is not set — nothing can be classified yet
      </p>
      <p className="mt-1.5 text-[0.78rem] leading-relaxed text-ink">
        Upwind and downwind are the same stretch of water without a wind direction, so every stretch
        on this track is currently <span className="mono">unclassified</span> and both run lists are
        legitimately empty. Nothing has been guessed to fill them. Choose the nearest station and the
        whole session classifies itself.
      </p>
      <button type="button" className="btn btn-primary mt-3" onClick={onFind}>
        Find the nearest station →
      </button>
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
      index="08"
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
