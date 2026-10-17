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

import { useCallback, useEffect, useMemo, useState } from "react";
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
  unit: SpeedUnit;
  onChange: (wind: WindModel, samples: WindSample[]) => void;
}

const PAD_MS = 15 * 60 * 1000;
const SIGNAL = "#14a45c";
const RULE = "#b5b0a3";
const QUIET = "#d5d1c6";

export default function WindPanel({
  startedAt,
  endedAt,
  centroid,
  wind,
  windSamples,
  summary,
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

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------- summary */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat
          label="Wind now used"
          value={describeWindSource(wind)}
          small
          hint={
            wind.station?.distanceKm != null
              ? `${wind.station.distanceKm.toFixed(1)} km from the track centre`
              : wind.kind === "manual"
                ? "constant for the whole session"
                : undefined
          }
        />
        <Stat
          label="Mean wind"
          value={
            summary.avgSpeedMps == null
              ? "—"
              : `${formatSpeed(summary.avgSpeedMps, unit)} / ${summary.avgSpeedMps.toFixed(1)}`
          }
          unit={`${SPEED_UNIT_LABEL[unit]} / m/s`}
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
          unit={SPEED_UNIT_LABEL[unit]}
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
                        <Chip color={s.hasWind ? SIGNAL : "#7b7870"}>
                          {s.hasWind ? "has data this session" : "no data this session"}
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

          {!searching && stations.length === 0 && !searchError && (
            <p className="mt-2 text-[0.7rem] text-grey">
              {providerById(activeProvider)?.available === "yes"
                ? "Press search to look for stations with wind for this session."
                : "This source cannot supply historical wind; use Frost or manual entry."}
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
        <div className="border-t border-rule pt-4">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange({ ...wind, kind: "none", station: null, manual: null }, [])}
          >
            Remove wind data
          </button>
          <p className="mt-1 text-[0.66rem] text-grey">
            Without wind there is no TWA, VMG or downwind classification — but nothing is guessed
            either.
          </p>
        </div>
      )}

      {!hasWind && !centroid && (
        <EmptyState
          title="No position to search from"
          body="This file has no usable GPS positions, so there is nowhere to look up wind. You can still enter it manually."
        />
      )}
      {wind.manual && (
        <p className="mono text-[0.66rem] text-grey">
          Current manual wind: {compassPoint(wind.manual.dirFromDeg)} {Math.round(wind.manual.dirFromDeg)}
          °, {formatSpeed(wind.manual.speedMps, unit)} {SPEED_UNIT_LABEL[unit]}
          {wind.manual.gustMps != null
            ? `, gusts ${formatSpeed(wind.manual.gustMps, unit)} ${SPEED_UNIT_LABEL[unit]}`
            : ""}
          .
        </p>
      )}
    </div>
  );
}
