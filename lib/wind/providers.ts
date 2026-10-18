/**
 * Weather provider registry (isomorphic — safe to import in the browser).
 *
 * The real network calls live in `lib/wind/server/*` and are only reachable through the
 * `/api/weather/*` route handlers, so API keys never reach the client. This file describes what
 * each provider is and does, which is what the UI needs to offer sensible choices and to explain
 * honestly where the numbers came from.
 */

import type { ProviderId, WindQuality, WindSourceKind } from "../types";

export interface WeatherProvider {
  id: ProviderId;
  name: string;
  /** how the data should be labelled in the UI */
  quality: WindQuality;
  /** true when the provider reports real instruments rather than a model */
  instrumented: boolean;
  /** true when the provider has a notion of named stations */
  stationBased: boolean;
  requiresKey: boolean;
  keyEnvVar: string | null;
  coverage: string;
  /** one sentence a rider can understand */
  summary: string;
  limitations: string;
  docsUrl: string;
  /** false when the integration is present but not usable yet */
  available: "yes" | "needs-key" | "partial";
}

export const WEATHER_PROVIDERS: Record<ProviderId, WeatherProvider> = {
  frost: {
    id: "frost",
    name: "MET Norway Frost",
    quality: "measured",
    instrumented: true,
    stationBased: true,
    requiresKey: true,
    keyEnvVar: "FROST_CLIENT_ID",
    coverage: "Norway, Svalbard and a few Nordic coastal stations",
    summary:
      "Official historical observations from MET Norway's station network, including coastal lighthouses and weather stations that report wind and gusts.",
    limitations:
      "Norway only, hourly or 10-minute resolution, and a station can be tens of kilometres away from where you sailed, so its wind is an estimate of the conditions on your track.",
    docsUrl: "https://frost.met.no/howto.html",
    available: "yes",
  },
  "open-meteo": {
    id: "open-meteo",
    name: "Open-Meteo (ERA5 reanalysis)",
    quality: "modelled",
    instrumented: false,
    stationBased: false,
    requiresKey: false,
    keyEnvVar: null,
    coverage: "Global",
    summary:
      "Global hourly wind from a numerical weather model, interpolated to the nearest grid point of your track. Useful anywhere Frost has no station.",
    limitations:
      "This is modelled wind, not an observation. It is smoothed, it will not show the gusts behind your local headland, and it must not be read as the conditions the rider felt.",
    docsUrl: "https://open-meteo.com/en/docs/historical-weather-api",
    available: "yes",
  },
  holfuy: {
    id: "holfuy",
    name: "Holfuy",
    quality: "measured",
    instrumented: true,
    stationBased: true,
    requiresKey: true,
    keyEnvVar: "HOLFUY_API_KEY",
    coverage: "Holfuy's own network of (often) spot-specific stations",
    summary:
      "Usually the mast at the spot itself, which makes it the most accurate source there is when one exists where you sail — and far better than an official station tens of kilometres away.",
    limitations:
      "Holfuy's API works and returns history for a whole day, but access is granted per station rather than to the network: email info@holfuy.hu with the station you ride and they open it, up to three for a non-owner. Until that is granted, every station answers \"no access\". They also expose no station directory and no coordinates, so the stations are configured rather than discovered, and querying by date returns their averaged rows rather than raw readings.",
    docsUrl: "https://api.holfuy.com",
    available: "needs-key",
  },
};

export const PROVIDER_IDS: ProviderId[] = ["frost", "open-meteo", "holfuy"];

export function providerById(id: string): WeatherProvider | null {
  return (WEATHER_PROVIDERS as Record<string, WeatherProvider>)[id] ?? null;
}

export function providerLabel(kind: WindSourceKind): string {
  if (kind === "manual") return "Manual wind";
  if (kind === "none") return "No wind data";
  const p = providerById(kind);
  return p ? p.name : kind;
}

/** Sentence used in the UI to keep the provenance of the wind obvious. */
export function qualityNote(quality: WindQuality, providerId: string): string {
  const provider = providerById(providerId);
  switch (quality) {
    case "measured":
      return `Measured at a real weather station${provider ? ` (${provider.name})` : ""}. Station wind is an estimate of what you felt on the water, not a measurement of it.`;
    case "modelled":
      return "Modelled wind from a weather model, not an observation. Treat it as context, not as the conditions you rode in.";
    case "manual":
      return "Wind you entered yourself. Used as a constant for the whole session.";
  }
}

/** Types shared between the route handlers and the client fetch helpers. */
export interface WeatherApiSuccess<T> {
  ok: true;
  data: T;
  notes: string[];
}

export interface WeatherApiFailure {
  ok: false;
  code:
    | "no_key"
    | "auth"
    | "not_found"
    | "bad_request"
    | "upstream"
    | "network"
    | "unsupported"
    | "empty";
  error: string;
  hint: string | null;
}

export type WeatherApiResponse<T> = WeatherApiSuccess<T> | WeatherApiFailure;
