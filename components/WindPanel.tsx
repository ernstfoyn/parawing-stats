"use client";

/**
 * Wind panel.
 *
 * The rider chooses where the wind comes from, and the app is explicit about what that means:
 *  - a real station (Frost) is *measured*, but at a station that may be kilometres away,
 *  - Open-Meteo is *modelled* and must never be read as what the rider felt,
 *  - manual entry is the rider's own number.
 *
 * When no station has data for the session window the panel says so and offers the alternatives
 * instead of quietly substituting something else.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeFailure,
  fetchObservations,
  fetchProviderStatus,
  findStations,
  type ProviderStatus,
} from "@/lib/wind/client";
import { PROVIDER_IDS, providerById, qualityNote, WEATHER_PROVIDERS } from "@/lib/wind/providers";
import type { WindSummary } from "@/lib/wind/align";
import { manualSamples } from "@/lib/wind/align";
import { axisDistance, axisIsUsable, type WindAxisEstimate } from "@/lib/wind/axis";
import { directionConsensus, type DirectionReport } from "@/lib/wind/consensus";
import { describeWindSource } from "@/lib/summary";
import {
  compassPoint,
  formatDirection,
  formatDuration,
  formatSpeed,
  knotsToMps,
  mpsToKnots,
  SPEED_UNIT_LABEL,
  type SpeedUnit,
} from "@/lib/units";
import type { StationRef, WindModel, WindSample } from "@/lib/types";
import { Chip, EmptyState, Field, Note, QualityBadge, Spinner, Stat } from "./ui";

export interface WindPanelProps {
  startedAt: number;
  endedAt: number;
  centroid: { lat: number; lon: number } | null;
  wind: WindModel;
  windSamples: WindSample[];
  summary: WindSummary;
  /** the wind axis read from the rider's own courses, or a withheld estimate */
  axis: WindAxisEstimate;
  /** rotate the measured direction by this much — see WindModel.directionBiasDeg */
  onRotate: (deg: number) => void;
  unit: SpeedUnit;
  onChange: (wind: WindModel, samples: WindSample[]) => void;
}

const PAD_MS = 15 * 60 * 1000;
const SIGNAL = "#14a45c";
const RULE = "#b5b0a3";
const QUIET = "#d5d1c6";

/**
 * What the rider's own courses say about the wind, and whether the station agrees.
 *
 * This is the one check on the wind direction that owes nothing to a weather service: a beat is
 * symmetric about the wind, so the courses themselves encode it. It is shown as a check, never applied
 * automatically — it can only give a *line*, and only when the session's courses were actually
 * symmetric. Both limits are stated where the number is.
 */
function OwnTrackAxis({
  axis,
  stationDir,
  biasDeg,
  onRotate,
}: {
  axis: WindAxisEstimate;
  stationDir: number | null;
  biasDeg: number;
  onRotate: (deg: number) => void;
}) {
  const usable = axisIsUsable(axis);
  const other = axis.axisDeg == null ? null : (axis.axisDeg + 180) % 360;
  const off = axisDistance(axis, stationDir);
  const evenSide = Math.round(50 + (1 - axis.balance) * 50);

  /** Signed rotation from the station's direction to the nearest end of the rider's axis. */
  const signedToAxis = (() => {
    if (axis.axisDeg == null || stationDir == null) return null;
    const ends = [axis.axisDeg, (axis.axisDeg + 180) % 360];
    let best = ends[0];
    for (const e of ends) {
      if (Math.abs(((e - stationDir + 540) % 360) - 180) < Math.abs(((best - stationDir + 540) % 360) - 180)) {
        best = e;
      }
    }
    return Math.round(((best - stationDir + 540) % 360) - 180);
  })();

  return (
    <div className="border-t border-rule pt-3">
      <div className="label">From your own track</div>
      {!usable ? (
        <p className="mt-1 text-[0.7rem] leading-relaxed text-grey">
          {axis.axisDeg == null
            ? "Your courses hold no symmetry to read a wind axis from — no beats or gybes on both sides."
            : axis.balance < 0.4
              ? `Too lopsided to read: ${evenSide}/${100 - evenSide} of the sailing was on one side, so the axis leans toward the tack you sailed most.`
              : axis.stabilityDeg != null && axis.stabilityDeg > 15
                ? `The first and second halves of the session disagree by ${Math.round(axis.stabilityDeg)}°, so the symmetry is a coincidence rather than a wind direction.`
                : "Not enough sailing to read an axis from."}
        </p>
      ) : (
        <p className="mt-1 text-[0.7rem] leading-relaxed text-graphite">
          Your tacks are symmetric about{" "}
          <span className="mono font-bold text-ink">
            {compassPoint(axis.axisDeg!)} {Math.round(axis.axisDeg!)}°
          </span>{" "}
          / <span className="mono">{Math.round(other!)}°</span> — a line, so it cannot tell which end
          the wind came from. {evenSide}/{100 - evenSide} split between the two sides, and both halves
          of the session agree within {Math.round(axis.stabilityDeg ?? 0)}°.{" "}
          {off == null ? (
            "Set a station to check it against."
          ) : off <= 5 ? (
            <>
              The station sits{" "}
              <span className="mono font-bold text-ink">{Math.round(off)}°</span> from your own
              geometry — as close as this check can resolve.
            </>
          ) : off <= 15 ? (
            <>
              The station is{" "}
              <span className="mono font-bold text-ink">{Math.round(off)}°</span> from your own
              geometry: inside the uncertainty of both, but not the same answer.
            </>
          ) : (
            <>
              The station sits{" "}
              <span className="mono font-bold text-ink">{Math.round(off)}°</span> from your own
              geometry, which is more than this check can explain away — and your tacks were at the
              spot while the station was not.
            </>
          )}
        </p>
      )}
      {/*
        A rotation in force is always clearable, even though the disagreement it was applied to is now
        zero — the first version hid the button in exactly that state, leaving no way back.
      */}
      {usable && (biasDeg !== 0 || (signedToAxis != null && signedToAxis !== 0)) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {biasDeg !== 0 ? (
            <>
              <span className="mono text-[0.62rem] uppercase tracking-[0.06em] text-ink">
                rotated {biasDeg > 0 ? "+" : ""}
                {Math.round(biasDeg)}°
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => onRotate(0)}>
                Back to as measured
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onRotate(signedToAxis!)}
            >
              Rotate the wind {signedToAxis! > 0 ? "+" : ""}
              {signedToAxis}° onto your own axis
            </button>
          )}
        </div>
      )}
      <p className="mt-1 text-[0.64rem] leading-relaxed text-grey">
        Read from your courses alone, with no wind measurement — which is why it is worth comparing.
        Rotating applies the difference to every observation rather than replacing them, so the timing
        and the source stay real, and the summary above says when a rotation is in force.
      </p>
    </div>
  );
}

/**
 * The nearest stations' directions, side by side, with the consensus and — the point — the spread.
 *
 * No average is offered as "the" wind: the number under the table says how far apart the stations are,
 * because five stations that agree are evidence and five that do not are a warning. That distinction
 * cannot be recovered from a single blended figure.
 */
function StationComparison({ reports, unit }: { reports: DirectionReport[]; unit: SpeedUnit }) {
  const consensus = directionConsensus(reports);
  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Station</th>
              <th className="num">Dist.</th>
              <th className="num">From</th>
              <th className="num">Speed</th>
              <th className="num">Obs.</th>
              <th className="num">Off consensus</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => {
              const off =
                consensus.dirFromDeg != null && r.dirFromDeg != null
                  ? Math.round(
                      Math.abs(
                        (((r.dirFromDeg - consensus.dirFromDeg + 540) % 360) - 180),
                      ),
                    )
                  : null;
              return (
                <tr key={r.id}>
                  <td className="text-graphite">{r.name}</td>
                  <td className="num">{r.distanceKm == null ? "—" : `${r.distanceKm.toFixed(1)} km`}</td>
                  <td className="num font-bold">
                    {r.dirFromDeg == null ? "—" : `${compassPoint(r.dirFromDeg)} ${Math.round(r.dirFromDeg)}°`}
                  </td>
                  <td className="num">{r.speedMps == null ? "—" : formatSpeed(r.speedMps, unit)}</td>
                  <td className="num text-grey">{r.observationCount}</td>
                  <td className="num text-grey">{off == null ? "—" : `${off}°`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {consensus.dirFromDeg != null && (
        <div className="mt-2 border-t border-quiet pt-2 text-[0.7rem] leading-relaxed text-graphite">
          <span className="mono uppercase tracking-[0.06em] text-grey">Distance-weighted mean</span>{" "}
          <span className="mono font-bold text-ink">
            {compassPoint(consensus.dirFromDeg)} {Math.round(consensus.dirFromDeg)}°
          </span>{" "}
          from {consensus.used} of {consensus.reported} station
          {consensus.reported === 1 ? "" : "s"}, and those sit at most{" "}
          <span className="mono font-bold text-ink">
            {consensus.spreadDeg == null ? "—" : `${Math.round(consensus.spreadDeg)}°`}
          </span>{" "}
          apart.{" "}
          {consensus.agreed
            ? "That is close enough that which one you pick hardly matters."
            : "That is a wide spread: these stations are not seeing the same wind, so the direction is a guess."}
          {consensus.outliers.length > 0 && (
            <>
              {" "}
              <span className="mono text-ink">
                {consensus.outliers.map((o) => o.name).join(", ")}
              </span>{" "}
              {consensus.outliers.length === 1 ? "is" : "are"} not in that group — a{" "}
              {Math.round(
                Math.abs(
                  (((consensus.outliers[0].dirFromDeg! - (consensus.dirFromDeg ?? 0) + 540) % 360) - 180),
                ),
              )}
              ° difference usually means an inland or sheltered exposure, not the wind on the water.
            </>
          )}
        </div>
      )}
      <p className="mt-1 text-[0.66rem] leading-relaxed text-grey">
        Direction is averaged as vectors, weighted by distance — not triangulated, because a direction
        is not a position. The mean is shown for orientation; the spread is the number to trust. Nothing
        here is interpolated into a station that did not report.
      </p>
    </div>
  );
}

export default function WindPanel({
  startedAt,
  endedAt,
  centroid,
  wind,
  windSamples,
  summary,
  axis,
  onRotate,
  unit,
  onChange,
}: WindPanelProps) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [activeProvider, setActiveProvider] = useState<string>(wind.kind === "none" ? "frost" : wind.kind);
  const [radiusKm, setRadiusKm] = useState(50);
  const [stations, setStations] = useState<StationRef[]>([]);
  const [stationNotes, setStationNotes] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loadingObs, setLoadingObs] = useState<string | null>(null);
  const [obsError, setObsError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<DirectionReport[] | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  const [manualSpeedKn, setManualSpeedKn] = useState(
    wind.manual ? mpsToKnots(wind.manual.speedMps).toFixed(1) : "17",
  );
  const [manualGustKn, setManualGustKn] = useState(
    wind.manual?.gustMps ? mpsToKnots(wind.manual.gustMps).toFixed(1) : "",
  );
  const [manualDir, setManualDir] = useState(
    wind.manual ? String(Math.round(wind.manual.dirFromDeg)) : "300",
  );

  useEffect(() => {
    let cancelled = false;
    fetchProviderStatus().then((list) => {
      if (!cancelled) setProviders(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const providerStatus = useMemo(
    () => providers.find((p) => p.id === activeProvider) ?? null,
    [providers, activeProvider],
  );

  const search = useCallback(async () => {
    if (!centroid) {
      setSearchError("This session has no GPS centroid to search from.");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setObsError(null);
    const res = await findStations({
      providerId: activeProvider,
      lat: centroid.lat,
      lon: centroid.lon,
      from: startedAt - PAD_MS,
      to: endedAt + PAD_MS,
      radiusKm,
    });
    setSearching(false);
    if (res.failure) {
      setStations([]);
      setStationNotes([]);
      const d = describeFailure(res.failure);
      setSearchError(`${d.title}. ${d.body}${d.hint ? ` ${d.hint}` : ""}`);
      return;
    }
    setStations(res.stations);
    setStationNotes(res.notes);
  }, [activeProvider, centroid, startedAt, endedAt, radiusKm]);

  const chooseStation = useCallback(
    async (station: StationRef) => {
      setLoadingObs(station.id);
      setObsError(null);
      const res = await fetchObservations({
        providerId: activeProvider,
        stationId: station.id,
        lat: station.lat,
        lon: station.lon,
        from: startedAt - PAD_MS,
        to: endedAt + PAD_MS,
      });
      setLoadingObs(null);
      if (res.failure) {
        const d = describeFailure(res.failure);
        setObsError(`${d.title}. ${d.body}${d.hint ? ` ${d.hint}` : ""}`);
        return;
      }
      if (res.samples.length === 0) {
        setObsError(
          "That station returned no observations for your session window, so no wind has been set. Nothing was invented to fill the gap.",
        );
        return;
      }
      onChange(
        { ...wind, kind: activeProvider as WindModel["kind"], station, manual: null },
        res.samples,
      );
    },
    [activeProvider, startedAt, endedAt, wind, onChange],
  );

  /**
   * Ask the nearest stations what direction they measured, so the rider can see whether they agree.
   *
   * A station ten kilometres away is not the wind at the spot, and the obvious hope is that several of
   * them can be combined into a better answer. They can be *averaged*, not triangulated — a direction is
   * not a position — and what matters more than the average is how far apart they are. Five stations
   * agreeing within four degrees is a solid direction; five disagreeing by forty is not, and this shows
   * which case the rider is in instead of choosing for them.
   */
  const compareNearby = useCallback(async () => {
    const candidates = stations.filter((s) => s.hasDirection && s.hasWind).slice(0, 5);
    if (candidates.length === 0) return;
    setComparing(true);
    setCompareError(null);
    const results = await Promise.all(
      candidates.map(async (station): Promise<DirectionReport> => {
        const res = await fetchObservations({
          providerId: activeProvider,
          stationId: station.id,
          lat: station.lat,
          lon: station.lon,
          from: startedAt - PAD_MS,
          to: endedAt + PAD_MS,
        });
        const withDir = res.failure ? [] : res.samples.filter((s) => s.dirFromDeg != null);
        let sine = 0;
        let cosine = 0;
        let speedSum = 0;
        let speedN = 0;
        for (const s of withDir) {
          const rad = (s.dirFromDeg! * Math.PI) / 180;
          sine += Math.sin(rad);
          cosine += Math.cos(rad);
          if (s.speedMps != null) {
            speedSum += s.speedMps;
            speedN++;
          }
        }
        const dir =
          withDir.length > 0 && Math.hypot(sine, cosine) > 1e-9
            ? ((Math.atan2(sine, cosine) * 180) / Math.PI + 360) % 360
            : null;
        return {
          id: station.id,
          name: station.name,
          distanceKm: station.distanceKm,
          dirFromDeg: dir,
          speedMps: speedN > 0 ? speedSum / speedN : null,
          observationCount: withDir.length,
        };
      }),
    );
    setComparing(false);
    const usable = results.filter((r) => r.dirFromDeg != null);
    if (usable.length === 0) {
      setComparison(null);
      setCompareError(
        "None of the nearby stations returned a wind direction for this session window, so there is nothing to compare. Nothing has been filled in.",
      );
      return;
    }
    setComparison(usable.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)));
  }, [stations, activeProvider, startedAt, endedAt]);

  const applyManual = useCallback(() => {
    const speedKn = Number(manualSpeedKn);
    const dir = Number(manualDir);
    if (!Number.isFinite(speedKn) || speedKn < 0 || !Number.isFinite(dir)) return;
    const gustKn = manualGustKn.trim() === "" ? null : Number(manualGustKn);
    const manual = {
      speedMps: knotsToMps(speedKn),
      dirFromDeg: ((dir % 360) + 360) % 360,
      gustMps: gustKn != null && Number.isFinite(gustKn) && gustKn >= 0 ? knotsToMps(gustKn) : null,
    };
    const range = { start: startedAt, end: endedAt };
    onChange({ ...wind, kind: "manual", station: null, manual }, manualSamples(manual, range));
  }, [manualSpeedKn, manualGustKn, manualDir, wind, startedAt, endedAt, onChange]);

  const hasWind = wind.kind !== "none";

  /**
   * The name of the source, without the provider prefixed to it.
   *
   * `describeWindSource` reads "MET Norway Frost · GULLHOLMEN", which is the right sentence for a
   * caption and the wrong thing to put in a stat cell: it overflows the column and collides with the
   * mean wind beside it. The station is what the rider recognises, so the station is the value and
   * the provider becomes the hint.
   */
  const usedName = wind.kind === "manual" ? "Manual wind" : (wind.station?.name ?? describeWindSource(wind));
  const usedHint =
    wind.kind === "manual"
      ? "your own number, constant for the session"
      : [
          wind.station ? providerById(wind.kind)?.name : describeWindSource(wind),
          wind.station?.distanceKm != null ? `${wind.station.distanceKm.toFixed(1)} km from the track centre` : null,
          // A rotation must never be silent: it changes every angle downstream.
          wind.directionBiasDeg
            ? `rotated ${wind.directionBiasDeg > 0 ? "+" : ""}${Math.round(wind.directionBiasDeg)}° onto your own track`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || undefined;

  /**
   * Find the candidate stations before the rider has to ask for them.
   *
   * A freshly imported file has no wind, and until one is set the whole session is unclassified —
   * so the list of nearby stations is the single most useful thing this panel can show, and making
   * the rider press a button to reveal it is a dead end they read as a broken app. This runs once,
   * only while nothing is set, and it never *applies* a station: the list is a suggestion, and
   * choosing stays the rider's decision.
   */
  const autoSearched = useRef(false);
  useEffect(() => {
    if (autoSearched.current || hasWind) return;
    if (providerStatus?.available !== "yes" || !centroid) return;
    autoSearched.current = true;
    // Started as a microtask rather than inline: `search` flips the spinner on its first line, and
    // setting state during the commit that scheduled this effect would cascade a render.
    void Promise.resolve().then(search);
  }, [hasWind, providerStatus, centroid, search]);

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------- summary */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat
          label="Wind now used"
          value={usedName}
          small
          hint={usedHint}
        />
        <Stat
          label="Mean wind"
          value={
            summary.avgSpeedMps == null
              ? "—"
              : `${formatSpeed(summary.avgSpeedMps, unit)} / ${summary.avgSpeedMps.toFixed(1)}`
          }
          unit={`${SPEED_UNIT_LABEL[unit]} / m/s`}
          hint={summary.avgSpeedMps == null ? "no observation landed on the track" : undefined}
        />
        <Stat
          label="Mean direction"
          value={formatDirection(summary.meanDirFromDeg)}
          small
          hint="the direction the wind comes FROM"
        />
        <Stat
          label="Peak gust"
          value={formatSpeed(summary.maxGustMps, unit)}
          // A dash with a unit next to it reads as a broken measurement. Say why it is missing.
          unit={summary.maxGustMps == null ? undefined : SPEED_UNIT_LABEL[unit]}
          small
          hint={summary.maxGustMps == null ? "this source reported no gusts" : undefined}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <QualityBadge quality={windSamples[0]?.quality ?? (wind.kind === "manual" ? "manual" : null)} />
        <Chip title="Share of track points that found an observation inside the tolerance window.">
          coverage {Math.round(summary.coverage * 100)}%
        </Chip>
        {summary.interpolatedFraction > 0 && (
          <Chip title="Points whose wind was interpolated between two observations.">
            {Math.round(summary.interpolatedFraction * 100)}% interpolated
          </Chip>
        )}
        {summary.observationCount > 0 && (
          <Chip>{summary.observationCount} observation(s)</Chip>
        )}
        {windSamples.length > 0 && summary.firstT != null && summary.lastT != null && (
          <Chip title="The window over which observations were available.">
            {formatDuration((summary.lastT - summary.firstT) / 1000)} of data
          </Chip>
        )}
      </div>

      {hasWind && (
        <Note>
          {qualityNote(
            windSamples[0]?.quality ?? (wind.kind === "manual" ? "manual" : "measured"),
            wind.kind === "manual" ? "manual" : wind.kind,
          )}
        </Note>
      )}

      <OwnTrackAxis
        axis={axis}
        stationDir={summary.meanDirFromDeg}
        biasDeg={wind.directionBiasDeg ?? 0}
        onRotate={onRotate}
      />

      {/* ------------------------------------------------------------- providers */}
      <div className="border-t border-rule pt-4">
        <div className="label">Choose a source</div>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_IDS.map((id) => {
            const p = WEATHER_PROVIDERS[id];
            const status = providers.find((x) => x.id === id);
            const configured = status?.configured ?? !p.requiresKey;
            const active = activeProvider === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveProvider(id)}
                className="border px-2.5 py-1.5 text-left transition-colors"
                style={{
                  borderColor: active ? "#121211" : RULE,
                  backgroundColor: active ? "#e7e3da" : "transparent",
                }}
              >
                <span className="block text-[0.76rem] font-semibold text-ink">{p.name}</span>
                <span className="mono block text-[0.62rem] uppercase tracking-[0.06em] text-grey">
                  {p.instrumented ? "instruments" : "modelled"}
                  {p.requiresKey ? (configured ? " · ready" : " · needs key") : " · no key"}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setActiveProvider("manual")}
            className="border px-2.5 py-1.5 text-left transition-colors"
            style={{
              borderColor: activeProvider === "manual" ? "#121211" : RULE,
              backgroundColor: activeProvider === "manual" ? "#e7e3da" : "transparent",
            }}
          >
            <span className="block text-[0.76rem] font-semibold text-ink">Manual</span>
            <span className="mono block text-[0.62rem] uppercase tracking-[0.06em] text-grey">
              your own number
            </span>
          </button>
        </div>

        {activeProvider !== "manual" && providerStatus && (
          <p className="mt-2 text-[0.7rem] leading-relaxed text-grey">
            {providerStatus.summary} <span className="text-grey/80">{providerStatus.limitations}</span>
          </p>
        )}
      </div>

      {/* --------------------------------------------------------------- station search */}
      {activeProvider !== "manual" && (
        <div className="border-t border-rule pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <button type="button" className="btn btn-primary" onClick={search} disabled={searching}>
              {searching ? "Searching…" : "Find stations near the track"}
            </button>
            <label className="flex items-center gap-2 text-[0.7rem] text-grey">
              within
              <select
                className="select w-24"
                value={radiusKm}
                onChange={(e) => setRadiusKm(Number(e.target.value))}
              >
                {[25, 50, 100, 200].map((r) => (
                  <option key={r} value={r}>
                    {r} km
                  </option>
                ))}
              </select>
            </label>
            {searching && <Spinner label="asking the weather service" />}
          </div>

          {searchError && <Note tone="warn">{searchError}</Note>}
          {obsError && <Note tone="warn">{obsError}</Note>}

          {stationNotes.map((n, i) => (
            <p key={i} className="mt-2 text-[0.7rem] leading-relaxed text-grey">
              {n}
            </p>
          ))}

          {stations.length > 0 && (
            <ul className="mt-3 space-y-1">
              {stations.map((s) => {
                const active = wind.station?.id === s.id && wind.kind === activeProvider;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => chooseStation(s)}
                      disabled={loadingObs != null}
                      className="w-full border px-3 py-2 text-left transition-colors disabled:opacity-60"
                      style={{
                        borderColor: active ? "#121211" : QUIET,
                        backgroundColor: active ? "#e7e3da" : "transparent",
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-[0.8rem] font-semibold text-ink">
                          {s.name}
                        </span>
                        <span className="mono shrink-0 text-[0.68rem] text-grey">
                          {s.distanceKm == null ? "—" : `${s.distanceKm.toFixed(1)} km`}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Chip
                          color={!s.hasWind ? "#7b7870" : s.hasDirection ? SIGNAL : "#e0763a"}
                          title={
                            s.hasDirection
                              ? "Wind speed and direction in your session window — enough to compute TWA and VMG."
                              : s.hasWind
                                ? "Wind speed only. Without direction there is no true wind angle, so this station cannot separate downwind from upwind."
                                : "No wind elements in your session window."
                          }
                        >
                          {!s.hasWind
                            ? "no data this session"
                            : s.hasDirection
                              ? "speed + direction"
                              : "speed only, no direction"}
                        </Chip>
                        <span className="mono text-[0.62rem] text-grey">
                          score {s.score.toFixed(2)}
                        </span>
                        {loadingObs === s.id && <Spinner label="loading wind" />}
                      </div>
                      {s.reasons.length > 0 && (
                        <p className="mt-1 text-[0.66rem] leading-relaxed text-grey">
                          {s.reasons.join(" ")}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {stations.length > 0 && (
            <div className="mt-4 border-t border-rule pt-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void compareNearby()}
                  disabled={comparing || stations.filter((s) => s.hasDirection).length === 0}
                >
                  {comparing ? "Comparing…" : "Compare the nearest stations"}
                </button>
                {comparison && (
                  <span className="mono text-[0.62rem] uppercase tracking-[0.06em] text-grey">
                    {comparison.length} station{comparison.length === 1 ? "" : "s"} reporting a
                    direction
                  </span>
                )}
              </div>

              {compareError && <Note tone="warn">{compareError}</Note>}

              {comparison && <StationComparison reports={comparison} unit={unit} />}

              {!comparison && !comparing && (
                <p className="mt-2 text-[0.68rem] leading-relaxed text-grey">
                  A station ten kilometres away is not the wind at the spot. Comparing the nearest few
                  shows whether they agree — and how much of the direction is guesswork.
                </p>
              )}
            </div>
          )}

          {!searching && stations.length === 0 && !searchError && (
            <p className="mt-2 text-[0.7rem] text-grey">
              {providerById(activeProvider)?.available !== "yes"
                ? "This source cannot supply historical wind; use Frost or manual entry."
                : hasWind
                  ? "No stations looked up in this session yet — search to see what else is nearby, or keep the station already in use."
                  : "Press search to look for stations with wind for this session."}
            </p>
          )}
        </div>
      )}

      {/* --------------------------------------------------------------- manual entry */}
      {activeProvider === "manual" && (
        <div className="border-t border-rule pt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Wind speed (kn)">
              <input
                className="input"
                inputMode="decimal"
                value={manualSpeedKn}
                onChange={(e) => setManualSpeedKn(e.target.value)}
              />
            </Field>
            <Field label="Gusts (kn, optional)">
              <input
                className="input"
                inputMode="decimal"
                value={manualGustKn}
                placeholder="—"
                onChange={(e) => setManualGustKn(e.target.value)}
              />
            </Field>
            <Field label="Direction (FROM, °)">
              <input
                className="input"
                inputMode="numeric"
                value={manualDir}
                onChange={(e) => setManualDir(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={applyManual}>
              Use this wind
            </button>
            <span className="mono text-[0.68rem] text-grey">
              {formatDirection(Number(manualDir))} ·{" "}
              {Number.isFinite(Number(manualSpeedKn))
                ? `${Number(manualSpeedKn).toFixed(1)} kn = ${knotsToMps(Number(manualSpeedKn)).toFixed(1)} m/s`
                : "—"}
            </span>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ clear */}
      {hasWind && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-rule pt-3">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ ...wind, kind: "none", station: null, manual: null }, [])}
          >
            Remove wind data
          </button>
          <p className="text-[0.66rem] text-grey">
            Without wind there is no TWA, no upwind VMG and no downwind classification — but nothing is
            guessed either.
          </p>
        </div>
      )}

      {!hasWind && !centroid && (
        <EmptyState
          title="No position to search from"
          body="This file has no usable GPS positions, so there is nowhere to look up wind. You can still enter it manually."
        />
      )}
    </div>
  );
}
