/**
 * MET Norway Frost provider.
 *
 * Flow:
 *  1. `sources` with `geometry=nearest(POINT(lon lat))` gives the stations closest to the track,
 *     including their coordinates and elevation.
 *  2. Keep the candidates inside the search radius and ask for the session's time window in ONE
 *     request for all of them (`sources=SN1,SN2,...`), which tells us which stations actually have
 *     wind data for the hour the rider was out. A station that is close but silent is useless.
 *  3. Rank by having data, then distance, then low elevation (coastal stations are near sea level),
 *     then a lighthouse-ish name, and describe the ranking in plain language.
 *
 * Credentials: Frost uses HTTP Basic auth with the client ID as the user name and an empty
 * password. Only this file sees the key.
 */

import { centroid } from "../../geo";
import type { StationRef, WindSample } from "../../types";
import type { WeatherApiFailure } from "../providers";
import {
  failure,
  fetchJson,
  isRecord,
  kmBetween,
  success,
  type ObservationsQuery,
  type ServerProvider,
  type ServerResult,
  type StationQuery,
} from "./types";

const BASE = process.env.FROST_BASE_URL || "https://frost.met.no";
const ELEMENTS = ["wind_speed", "wind_from_direction"] as const;
const OPTIONAL_ELEMENTS = ["wind_speed_of_gust", "air_temperature"] as const;

export function frostConfigured(): boolean {
  return Boolean(process.env.FROST_CLIENT_ID);
}

function authHeader(): string {
  const id = process.env.FROST_CLIENT_ID ?? "";
  return `Basic ${Buffer.from(`${id}:`).toString("base64")}`;
}

function isoTime(t: number): string {
  return new Date(t).toISOString();
}

/** Map Frost's HTTP status onto a message a rider can act on. */
function httpFailure(status: number, body: unknown, context: string): WeatherApiFailure {
  const message =
    (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : null) ?? `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return {
      ok: false,
      code: "auth",
      error: `Frost rejected the credentials (${message}).`,
      hint: "Check that FROST_CLIENT_ID is a valid Frost client ID for your registered user, and that no trailing spaces were copied into the environment variable.",
    };
  }
  if (status === 404) {
    return { ok: false, code: "not_found", error: `Frost has no such ${context} (${message}).`, hint: null };
  }
  if (status === 400) {
    return { ok: false, code: "bad_request", error: `Frost rejected the request: ${message}`, hint: null };
  }
  if (status === 429) {
    return {
      ok: false,
      code: "upstream",
      error: "Frost is rate limiting this account.",
      hint: "Wait a moment and try again; the free tier allows a limited number of requests per day.",
    };
  }
  return { ok: false, code: "upstream", error: `Frost returned an error: ${message}`, hint: null };
}

interface FrostCandidate {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  masl: number | null;
  validFrom: number | null;
  validTo: number | null;
}

function parseSources(json: unknown): FrostCandidate[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  const out: FrostCandidate[] = [];
  for (const raw of json.data) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id : null;
    if (!id) continue;
    let lat: number | null = null;
    let lon: number | null = null;
    if (isRecord(raw.geometry) && Array.isArray(raw.geometry.coordinates)) {
      const [l, a] = raw.geometry.coordinates as unknown[];
      if (typeof l === "number" && typeof a === "number") {
        lon = l;
        lat = a;
      }
    }
    const maslRaw = raw.masl ?? raw.elevation ?? null;
    out.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
      lat,
      lon,
      masl: typeof maslRaw === "number" ? maslRaw : null,
      validFrom: typeof raw.validFrom === "string" ? Date.parse(raw.validFrom) : null,
      validTo: typeof raw.validTo === "string" ? Date.parse(raw.validTo) : null,
    });
  }
  return out;
}

/** Count the wind observations each source has inside the session window. */
function parseObservationCounts(json: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (!isRecord(json) || !Array.isArray(json.data)) return counts;
  for (const row of json.data) {
    if (!isRecord(row)) continue;
    const sourceId = typeof row.sourceId === "string" ? row.sourceId : null;
    if (!sourceId) continue;
    if (!Array.isArray(row.observations)) continue;
    const hasWind = row.observations.some(
      (o) =>
        isRecord(o) &&
        (o.elementId === "wind_speed" || o.elementId === "wind_from_direction") &&
        typeof o.value === "number",
    );
    if (hasWind) {
      // Frost reports parallel sensors as "SN12345:0"; the station id is the part before the colon.
      const base = sourceId.split(":")[0];
      counts.set(base, (counts.get(base) ?? 0) + 1);
    }
  }
  return counts;
}

function parseObservations(json: unknown, stationId: string, quality: "measured"): WindSample[] {
  if (!isRecord(json) || !Array.isArray(json.data)) return [];
  const byTime = new Map<number, WindSample>();
  for (const row of json.data) {
    if (!isRecord(row)) continue;
    const sourceId = typeof row.sourceId === "string" ? row.sourceId : "";
    if (sourceId.split(":")[0] !== stationId.split(":")[0]) continue;
    const t = typeof row.referenceTime === "string" ? Date.parse(row.referenceTime) : NaN;
    if (!Number.isFinite(t)) continue;
    if (!Array.isArray(row.observations)) continue;
    const sample: WindSample =
      byTime.get(t) ?? {
        t,
        speedMps: null,
        gustMps: null,
        dirFromDeg: null,
        tempC: null,
        quality,
        providerId: "frost",
        stationId,
      };
    for (const o of row.observations) {
      if (!isRecord(o) || typeof o.value !== "number") continue;
      switch (o.elementId) {
        case "wind_speed":
          sample.speedMps = o.value;
          break;
        case "wind_speed_of_gust":
        case "max(wind_speed PT1H)":
          sample.gustMps = o.value;
          break;
        case "wind_from_direction":
          sample.dirFromDeg = ((o.value % 360) + 360) % 360;
          break;
        case "air_temperature":
          sample.tempC = o.value;
          break;
        default:
          break;
      }
    }
    byTime.set(t, sample);
  }
  return [...byTime.values()]
    .filter((s) => s.speedMps != null || s.dirFromDeg != null)
    .sort((a, b) => a.t - b.t);
}

async function requestObservations(
  sourceIds: string[],
  from: number,
  to: number,
): Promise<ServerResult<unknown>> {
  const common = {
    sources: sourceIds.join(","),
    referencetime: `${isoTime(from)}/${isoTime(to)}`,
    levels: "default",
    timeoffsets: "default",
  };
  const headers = { Authorization: authHeader(), Accept: "application/json" };

  let res = await fetchJson(
    `${BASE}/observations/v0.jsonld?${new URLSearchParams({ ...common, elements: [...ELEMENTS, ...OPTIONAL_ELEMENTS].join(",") })}`,
    { headers },
  );
  if (!res.ok) return { ok: false, failure: res.failure };

  // If one of the optional elements does not exist, Frost rejects the whole request. Retry with
  // the two elements that are certain to exist rather than giving up and showing no wind at all.
  if (res.status === 400) {
    res = await fetchJson(
      `${BASE}/observations/v0.jsonld?${new URLSearchParams({ ...common, elements: ELEMENTS.join(",") })}`,
      { headers },
    );
    if (!res.ok) return { ok: false, failure: res.failure };
  }

  if (res.status !== 200 && res.status !== 206) {
    return { ok: false, failure: httpFailure(res.status, res.json, "observation request") };
  }
  return success(res.json);
}

export const frostProvider: ServerProvider = {
  id: "frost",

  async listStations(query: StationQuery) {
    if (!frostConfigured()) {
      return failure(
        "no_key",
        "Frost credentials are not configured on this server.",
        "Register a free user at frost.met.no, then set FROST_CLIENT_ID (the client ID acts as the user name, the password stays empty) and restart the app.",
      );
    }

    const point = `${query.lon} ${query.lat}`;
    const params = new URLSearchParams({
      types: "Observations",
      geometry: `nearest(POINT(${point}))`,
      elements: [...ELEMENTS].join(","),
    });

    let res = await fetchJson(`${BASE}/sources/v0.jsonld?${params}`, {
      headers: { Authorization: authHeader(), Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, failure: res.failure };

    if (res.status === 400) {
      // Some Frost deployments are picky about `elements` on the sources resource.
      const retry = new URLSearchParams({
        types: "Observations",
        geometry: `nearest(POINT(${point}))`,
      });
      res = await fetchJson(`${BASE}/sources/v0.jsonld?${retry}`, {
        headers: { Authorization: authHeader(), Accept: "application/json" },
      });
      if (!res.ok) return { ok: false, failure: res.failure };
    }

    if (res.status !== 200 && res.status !== 206) {
      return { ok: false, failure: httpFailure(res.status, res.json, "station") };
    }

    const candidates = parseSources(res.json);
    if (candidates.length === 0) {
      return success([], [
        "Frost knows no wind stations near this track. Try Open-Meteo (modelled, global) or enter the wind manually.",
      ]);
    }

    const withinRadius = candidates
      .map((c) => ({ c, distanceKm: kmBetween(query.lat, query.lon, c.lat, c.lon) }))
      .filter((x) => x.distanceKm != null && x.distanceKm <= query.radiusKm)
      .sort((a, b) => a.distanceKm! - b.distanceKm!)
      .slice(0, 12);

    const scope = withinRadius.length > 0 ? withinRadius : candidates.slice(0, 6).map((c) => ({
      c,
      distanceKm: kmBetween(query.lat, query.lon, c.lat, c.lon),
    }));

    const notes: string[] = [];
    if (withinRadius.length === 0) {
      notes.push(
        `No Frost station reports wind within ${query.radiusKm} km of this track; the nearest stations are shown so you can judge for yourself.`,
      );
    }

    // One request for every candidate, so we know who really has data for this hour.
    const counts = new Map<string, number>();
    if (scope.length > 0) {
      const obs = await requestObservations(
        scope.map((s) => s.c.id),
        query.from,
        query.to,
      );
      if (obs.ok) {
        for (const [id, n] of parseObservationCounts(obs.data)) counts.set(id, n);
      } else {
        notes.push(`Could not check observation coverage: ${obs.failure.error}`);
      }
    }

    const stations: StationRef[] = scope.map(({ c, distanceKm }) => {
      const observations = counts.get(c.id) ?? 0;
      const reasons: string[] = [];
      if (distanceKm != null) reasons.push(`${distanceKm.toFixed(1)} km from the centre of your track.`);
      if (observations > 0) {
        reasons.push(`${observations} wind observation(s) inside your session window.`);
      } else {
        reasons.push("No wind observations in your session window.");
      }
      if (c.masl != null) {
        reasons.push(
          c.masl <= 30
            ? `Low station (${Math.round(c.masl)} m above sea level), typical of a coastal site.`
            : `${Math.round(c.masl)} m above sea level, so it may sit in different wind than the water.`,
        );
      }
      if (/fyr|odde|havn|kyst|nes|holme|øy|landet/i.test(c.name)) {
        reasons.push("Name suggests an exposed coastal site.");
      }
      if (c.validTo != null && c.validTo < query.from) {
        reasons.push("This station's record ends before your session.");
      }

      return {
        providerId: "frost",
        id: c.id,
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        elevationM: c.masl,
        distanceKm,
        elements: observations > 0 ? ["wind_speed", "wind_from_direction", ...OPTIONAL_ELEMENTS] : [],
        reasons,
        score: scoreStation({ distanceKm, observations, masl: c.masl, name: c.name, validTo: c.validTo, from: query.from }),
        hasWind: observations > 0,
      } satisfies StationRef;
    });

    stations.sort((a, b) => b.score - a.score);
    return success(stations, notes);
  },

  async fetchObservations(query: ObservationsQuery) {
    if (!frostConfigured()) {
      return failure(
        "no_key",
        "Frost credentials are not configured on this server.",
        "Set FROST_CLIENT_ID in the environment (or in Netlify's environment variables) and redeploy.",
      );
    }
    const res = await requestObservations([query.stationId], query.from, query.to);
    if (!res.ok) return res;
    const samples = parseObservations(res.data, query.stationId, "measured");
    const notes: string[] = [];
    if (samples.length === 0) {
      notes.push(
        "This station returned no wind observations for your session window. It may have been offline, or its data may not be quality controlled yet.",
      );
    }
    return success(samples, notes);
  },
};

/**
 * Ranking. Having data for the session is the single strongest signal; after that, proximity,
 * a coastal (low) elevation and an exposed-sounding name win. The weight of every term is small
 * and additive so the ordering stays predictable and explainable.
 */
export function scoreStation(input: {
  distanceKm: number | null;
  observations: number;
  masl: number | null;
  name: string;
  validTo: number | null;
  from: number;
}): number {
  let score = 0;
  if (input.observations > 0) score += 0.45;
  if (input.distanceKm != null) score += 0.3 * Math.exp(-input.distanceKm / 12);
  if (input.masl != null) {
    if (input.masl <= 30) score += 0.12;
    else if (input.masl <= 120) score += 0.06;
    else if (input.masl > 400) score -= 0.1;
  }
  if (/fyr|odde|havn|kyst|nes|holme/i.test(input.name)) score += 0.08;
  if (input.validTo != null && input.validTo < input.from) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

/** Centroid helper so the route can query with a single point derived from the whole track. */
export function trackCentroid(points: { lat: number; lon: number }[]): { lat: number; lon: number } | null {
  return centroid(points);
}
