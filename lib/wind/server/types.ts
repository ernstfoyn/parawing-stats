/**
 * Server-side weather integration.
 *
 * Everything in this folder is only imported from route handlers, so API credentials stay on the
 * server. Each provider is a small object with the same shape, which is what makes adding Strava,
 * a Garmin export or another wind network later a local change rather than a refactor.
 */

import { haversineM } from "../../geo";
import type { StationRef, WindSample } from "../../types";
import type { WeatherApiFailure } from "../providers";

export interface StationQuery {
  lat: number;
  lon: number;
  from: number;
  to: number;
  radiusKm: number;
  /** activity centroid and bounding box, used for the station ranking notes */
  elementFilter?: string[];
}

export interface ObservationsQuery {
  stationId: string;
  lat: number | null;
  lon: number | null;
  from: number;
  to: number;
}

export interface ServerProvider {
  id: string;
  /** true when the provider can list candidate stations */
  listStations(query: StationQuery): Promise<ServerResult<StationRef[]>>;
  fetchObservations(query: ObservationsQuery): Promise<ServerResult<WindSample[]>>;
}

export type ServerResult<T> =
  | { ok: true; data: T; notes: string[] }
  | { ok: false; failure: WeatherApiFailure };

export function failure(
  code: WeatherApiFailure["code"],
  error: string,
  hint: string | null = null,
): { ok: false; failure: WeatherApiFailure } {
  return { ok: false, failure: { ok: false, code, error, hint } };
}

export function success<T>(data: T, notes: string[] = []): { ok: true; data: T; notes: string[] } {
  return { ok: true, data, notes };
}

/** Great-circle distance in km, or null when the station has no coordinates. */
export function kmBetween(
  lat: number,
  lon: number,
  stationLat: number | null,
  stationLon: number | null,
): number | null {
  if (stationLat == null || stationLon == null) return null;
  return haversineM({ lat, lon }, { lat: stationLat, lon: stationLon }) / 1000;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Fetch a plain-text body with a timeout.
 *
 * Some sources publish data as JavaScript or HTML rather than JSON — Holfuy's public station page is
 * one — and `fetchJson` cannot read those: it tries to parse and leaves `json` null. This returns the
 * text and the same readable failures.
 */
export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<{ ok: true; status: number; text: string } | { ok: false; failure: WeatherApiFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    return { ok: true, status: res.status, text: await res.text() };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      failure: {
        ok: false,
        code: "network",
        error: aborted
          ? "The weather service did not answer in time."
          : `Could not reach the weather service: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Check your internet connection and try again. You can always enter the wind manually.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch JSON with a timeout, turning every transport problem into a readable failure. */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<{ ok: true; status: number; json: unknown } | { ok: false; failure: WeatherApiFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      failure: {
        ok: false,
        code: "network",
        error: aborted
          ? "The weather service did not answer in time."
          : `Could not reach the weather service: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Check your internet connection and try again. You can always enter the wind manually.",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
