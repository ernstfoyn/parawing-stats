/**
 * Open-Meteo provider (ERA5 reanalysis + recent model runs), keyless and global.
 *
 * Included as the fallback for everywhere MET Norway has no station — which is most of the
 * world. Its data is *modelled*, and every sample is tagged `modelled` so the UI can say so.
 * Never used automatically: the rider has to pick it (or the app offers it after Frost fails).
 *
 * Endpoint choice: ERA5 has a multi-day lag, so a session from the last few days is fetched from
 * the forecast endpoint with `past_days` instead, which is the only way to get wind for "last
 * Saturday" without pretending the archive has it.
 */

import type { StationRef, WindSample } from "../../types";
import { fetchJson, isRecord, success, type ServerProvider } from "./types";

const ARCHIVE_BASE = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const HOURLY = ["wind_speed_10m", "wind_direction_10m", "wind_gusts_10m"] as const;

/** ERA5 lags reality by roughly this long; newer sessions need the forecast endpoint. */
const ARCHIVE_LAG_DAYS = 6;

function isoDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export interface OpenMeteoFetchResult {
  samples: WindSample[];
  /** the coordinates the model actually resolved to */
  lat: number;
  lon: number;
  elevationM: number | null;
  source: "archive" | "forecast";
}

export async function fetchOpenMeteo(
  lat: number,
  lon: number,
  from: number,
  to: number,
): Promise<
  | { ok: true; data: OpenMeteoFetchResult; notes: string[] }
  | { ok: false; failure: import("../providers").WeatherApiFailure }
> {
  const daysSinceEnd = (Date.now() - to) / 86_400_000;
  const useForecast = daysSinceEnd < ARCHIVE_LAG_DAYS;

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY.join(","),
    wind_speed_unit: "ms",
    timezone: "UTC",
    cell_selection: "nearest",
  });
  if (useForecast) {
    // Ask for enough history to cover the session, but not more than the API allows.
    const pastDays = Math.min(92, Math.max(1, Math.ceil(daysSinceEnd) + 1));
    params.set("past_days", String(pastDays));
    params.set("forecast_days", "1");
  } else {
    // A one-day pad covers sessions that straddle midnight.
    params.set("start_date", isoDate(from - 86_400_000));
    params.set("end_date", isoDate(to + 86_400_000));
  }

  const url = `${useForecast ? FORECAST_BASE : ARCHIVE_BASE}?${params}`;
  const res = await fetchJson(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return { ok: false, failure: res.failure };
  if (res.status !== 200) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "upstream",
        error: `Open-Meteo returned HTTP ${res.status}.`,
        hint: "Try again later, or enter the wind manually.",
      },
    };
  }

  const json = res.json;
  if (!isRecord(json) || !isRecord(json.hourly) || !Array.isArray(json.hourly.time)) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "empty",
        error: "Open-Meteo returned no hourly wind data for this location and time.",
        hint: "Historical model data is unavailable for very recent or very old dates. Enter the wind manually.",
      },
    };
  }

  const times = json.hourly.time as unknown[];
  const speeds = (json.hourly.wind_speed_10m ?? []) as unknown[];
  const dirs = (json.hourly.wind_direction_10m ?? []) as unknown[];
  const gusts = (json.hourly.wind_gusts_10m ?? []) as unknown[];

  const samples: WindSample[] = [];
  for (let i = 0; i < times.length; i++) {
    const raw = times[i];
    if (typeof raw !== "string") continue;
    // timezone=UTC was requested, and a bare datetime without an offset parses as *local* in JS,
    // so the Z must be added explicitly.
    const t = Date.parse(`${raw}Z`);
    if (!Number.isFinite(t)) continue;
    if (t < from - 86_400_000 || t > to + 86_400_000) continue;
    const speedMps = typeof speeds[i] === "number" ? (speeds[i] as number) : null;
    const dirFromDeg = typeof dirs[i] === "number" ? (((dirs[i] as number) % 360) + 360) % 360 : null;
    const gustMps = typeof gusts[i] === "number" ? (gusts[i] as number) : null;
    if (speedMps == null && dirFromDeg == null) continue;
    samples.push({
      t,
      speedMps,
      gustMps,
      dirFromDeg,
      quality: "modelled",
      providerId: "open-meteo",
      stationId: "open-meteo-grid",
    });
  }

  if (samples.length === 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "empty",
        error: "Open-Meteo has no wind values covering your session window.",
        hint: "Enter the wind manually, or try a MET Norway station if you sailed in Norway.",
      },
    };
  }

  return success(
    {
      samples,
      lat: typeof json.latitude === "number" ? json.latitude : lat,
      lon: typeof json.longitude === "number" ? json.longitude : lon,
      elevationM: typeof json.elevation === "number" ? json.elevation : null,
      source: useForecast ? "forecast" : "archive",
    },
    [
      useForecast
        ? "Wind fetched from the Open-Meteo forecast model (recent sessions are not in the ERA5 archive yet)."
        : "Wind fetched from the ERA5 reanalysis archive.",
      "This is modelled wind on a coarse grid, not an observation at your spot.",
    ],
  );
}

export const openMeteoProvider: ServerProvider = {
  id: "open-meteo",

  async listStations(query) {
    // One model grid point, presented as a pseudo-station so the picker looks the same everywhere.
    const station: StationRef = {
      providerId: "open-meteo",
      id: "open-meteo-grid",
      name: `ERA5 model grid (${query.lat.toFixed(3)}, ${query.lon.toFixed(3)})`,
      lat: query.lat,
      lon: query.lon,
      elevationM: null,
      distanceKm: 0,
      elements: [...HOURLY],
      reasons: [
        "Modelled wind interpolated to the point you asked about — no physical station is involved.",
        "Hourly resolution, so it cannot show short gusts or a local sea breeze behind a headland.",
      ],
      score: 0.45,
      hasWind: true,
      hasDirection: true,
    };
    return success([station], ["Open-Meteo provides modelled wind, not station observations."]);
  },

  async fetchObservations(query) {
    if (query.lat == null || query.lon == null) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "bad_request",
          error: "Open-Meteo needs the coordinates of the track to interpolate the model.",
          hint: null,
        },
      };
    }
    const res = await fetchOpenMeteo(query.lat, query.lon, query.from, query.to);
    if (!res.ok) return res;
    return success(res.data.samples, res.notes);
  },
};
