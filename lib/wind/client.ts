/**
 * Browser-side weather client.
 *
 * The UI never talks to a weather API directly; it goes through these helpers, which hit the
 * route handlers. That keeps credentials server-side and gives one place to handle the honest
 * error states (missing key, no station, rate limit).
 */

import type { StationRef, WindSample } from "../types";
import type { WeatherApiFailure, WeatherApiResponse } from "./providers";
import { providerById } from "./providers";

export interface ProviderStatus {
  id: string;
  name: string;
  quality: "measured" | "modelled" | "manual";
  instrumented: boolean;
  stationBased: boolean;
  requiresKey: boolean;
  keyEnvVar: string | null;
  coverage: string;
  summary: string;
  limitations: string;
  docsUrl: string;
  available: "yes" | "needs-key" | "partial";
  configured: boolean;
}

async function getJson<T>(path: string, params: Record<string, string | number>): Promise<WeatherApiResponse<T>> {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  try {
    const res = await fetch(`${path}?${query}`);
    const body = (await res.json()) as WeatherApiResponse<T> | { ok: false; error?: string };
    if (!body || typeof body !== "object" || !("ok" in body)) {
      return {
        ok: false,
        code: "upstream",
        error: "The weather proxy returned an unexpected response.",
        hint: "Check the server logs. Manual wind entry still works.",
      };
    }
    return body as WeatherApiResponse<T>;
  } catch (err) {
    return {
      ok: false,
      code: "network",
      error: `Could not reach the weather proxy: ${err instanceof Error ? err.message : String(err)}`,
      hint: "The app works offline apart from weather lookups. Enter the wind manually if you know it.",
    };
  }
}

export async function fetchProviderStatus(): Promise<ProviderStatus[]> {
  try {
    const res = await fetch("/api/weather/providers");
    const body = (await res.json()) as { ok: boolean; providers?: ProviderStatus[] };
    return body.providers ?? [];
  } catch {
    return [];
  }
}

export interface StationSearchResult {
  stations: StationRef[];
  notes: string[];
  failure: WeatherApiFailure | null;
}

export async function findStations(input: {
  providerId: string;
  lat: number;
  lon: number;
  from: number;
  to: number;
  radiusKm?: number;
}): Promise<StationSearchResult> {
  const res = await getJson<StationRef[]>("/api/weather/stations", {
    provider: input.providerId,
    lat: input.lat,
    lon: input.lon,
    from: input.from,
    to: input.to,
    radiusKm: input.radiusKm ?? 50,
  });
  if (!res.ok) return { stations: [], notes: [], failure: res };
  return { stations: res.data, notes: res.notes, failure: null };
}

export interface ObservationResult {
  samples: WindSample[];
  notes: string[];
  failure: WeatherApiFailure | null;
}

export async function fetchObservations(input: {
  providerId: string;
  stationId: string;
  lat?: number | null;
  lon?: number | null;
  from: number;
  to: number;
}): Promise<ObservationResult> {
  const params: Record<string, string | number> = {
    provider: input.providerId,
    station: input.stationId,
    from: input.from,
    to: input.to,
  };
  if (input.lat != null) params.lat = input.lat;
  if (input.lon != null) params.lon = input.lon;
  const res = await getJson<WindSample[]>("/api/weather/observations", params);
  if (!res.ok) return { samples: [], notes: [], failure: res };
  return { samples: res.data, notes: res.notes, failure: null };
}

/** Human-readable description of a provider failure, for the wind panel. */
export function describeFailure(failure: WeatherApiFailure): {
  title: string;
  body: string;
  hint: string | null;
  needsKey: boolean;
} {
  switch (failure.code) {
    case "no_key":
      return {
        title: "This weather source is not configured",
        body: failure.error,
        hint:
          failure.hint ??
          "Add the API credentials to the server environment, or use a source that needs no key.",
        needsKey: true,
      };
    case "auth":
      return {
        title: "The weather service rejected the credentials",
        body: failure.error,
        hint: failure.hint,
        needsKey: true,
      };
    case "not_found":
      return { title: "Not found", body: failure.error, hint: failure.hint, needsKey: false };
    case "bad_request":
      return {
        title: "The weather service rejected the request",
        body: failure.error,
        hint: failure.hint ?? "This is usually a bug in the request; please report it.",
        needsKey: false,
      };
    case "empty":
      return { title: "No data available", body: failure.error, hint: failure.hint, needsKey: false };
    case "unsupported":
      return { title: "Not implemented", body: failure.error, hint: failure.hint, needsKey: false };
    case "network":
      return { title: "Network problem", body: failure.error, hint: failure.hint, needsKey: false };
    default:
      return { title: "Weather lookup failed", body: failure.error, hint: failure.hint, needsKey: false };
  }
}

/** Provider metadata for a failure, so the error can name the source that failed. */
export function failureProvider(failure: WeatherApiFailure, providerId: string): string {
  return providerById(providerId)?.name ?? providerId;
}
