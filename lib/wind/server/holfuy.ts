/**
 * Holfuy provider — the spot's own mast, when you have access to it.
 *
 * Holfuy's stations are usually *at* the spot, installed by the pilots and riders who sail there,
 * which makes them the best possible wind source and much better than a Frost station tens of
 * kilometres away. This was a stub for a long time on the belief that only the current reading was
 * available. That belief was wrong, and it is worth recording why, because it cost a rider real
 * accuracy:
 *
 *  - `https://api.holfuy.com/live/?s=<id>&m=JSON` returns the current reading,
 *  - `https://api.holfuy.com/archive/?s=<id>&start_date=YYYY-MM-DD&stop_date=YYYY-MM-DD&m=JSON`
 *    returns history for a whole day, which is exactly what a past session needs,
 *  - both are documented (History API V1.7, Weather Report API V4.1) and both work.
 *
 * What they are not is public. Every station answers `no_access` until Holfuy grants a password for
 * that station, from their API page: "The API-s are mainly for station owners, but we can open the
 * actual data API for other users also for maximum 3 stations. Please contact us at info@holfuy.hu
 * for access." There is also no public station directory — Holfuy exposes one through their website
 * only — so the stations to watch are configured rather than discovered, which matches how the access
 * is granted anyway: per station, a handful at most.
 *
 * Configuration:
 *   HOLFUY_API_KEY   the API password, one password covering the stations you were granted
 *   HOLFUY_STATIONS  comma-separated station ids, e.g. "1199" for OKK – Larkollen
 *
 * Resolution: querying by date returns Holfuy's averaged rows rather than raw readings (their
 * documentation: giving `start_date` forces the averaged type). The app reports how many observations
 * it actually got and over what share of the track, so the resolution is visible rather than assumed.
 */

import type { StationRef, WindSample } from "../../types";
import { failure, fetchJson, isRecord, success, type ServerProvider } from "./types";

const API = "https://api.holfuy.com";

/** The password, or null when Holfuy access has not been granted yet. */
export function holfuyKey(): string | null {
  const key = process.env.HOLFUY_API_KEY?.trim();
  return key ? key : null;
}

/** The stations this Holfuy password covers, in the order the rider listed them. */
export function holfuyStationIds(): string[] {
  const raw = process.env.HOLFUY_STATIONS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NOT_GRANTED_HINT =
  "Holfuy grants API access per station, and mainly to station owners: email info@holfuy.hu, say which station you ride (OKK – Larkollen is 1199) and what you want it for, and they will open it for you — up to 3 stations for non-owners. Then set HOLFUY_API_KEY (the password) and HOLFUY_STATIONS on the server.";

function ymd(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** The wind a Holfuy row carries, in m/s, or nulls when the row has no wind. */
function rowToSample(row: unknown, providerId: string, stationId: string): WindSample | null {
  if (!isRecord(row)) return null;
  const dateTime = typeof row.dateTime === "string" ? row.dateTime : null;
  if (!dateTime) return null;
  // Holfuy reports CE(S)T unless `utc` is passed; we always pass it, so treat the string as UTC.
  const t = Date.parse(`${dateTime.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return null;

  const wind = isRecord(row.wind) ? row.wind : {};
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  return {
    t,
    speedMps: num(wind.speed),
    gustMps: num(wind.gust),
    dirFromDeg: num(wind.direction),
    tempC: num(row.temperature),
    quality: "measured",
    providerId,
    stationId,
  };
}

/** Parse an archive response. Exported so the shape can be tested without calling Holfuy. */
export function parseHolfuyArchive(
  json: unknown,
  stationId = "holfuy",
  providerId = "holfuy",
): WindSample[] {
  if (!isRecord(json)) return [];
  const rows = Array.isArray(json.measurements) ? json.measurements : [];
  const out: WindSample[] = [];
  for (const row of rows) {
    const sample = rowToSample(row, providerId, stationId);
    if (sample) out.push(sample);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** A readable message for Holfuy's own error codes. */
function archiveFailure(json: unknown): { error: string; hint: string } | null {
  if (!isRecord(json)) return null;
  const code = typeof json.errorCode === "string" ? json.errorCode : null;
  const error = typeof json.error === "string" ? json.error : null;
  if (!code && !error) return null;
  if (code === "no_access" || error === "No access") {
    return {
      error: "Holfuy refused access to that station.",
      hint: NOT_GRANTED_HINT,
    };
  }
  return { error: error ?? "Holfuy rejected the request.", hint: NOT_GRANTED_HINT };
}

export const holfuyProvider: ServerProvider = {
  id: "holfuy",

  /**
   * Holfuy publishes no station directory, so the candidates are the stations the rider configured —
   * which is also exactly the set their password covers. A live reading is queried for each purely to
   * pick up its name, so the list reads "OKK – Larkollen" rather than "1199".
   */
  async listStations() {
    const key = holfuyKey();
    if (!key) {
      return failure(
        "no_key",
        "Holfuy is not configured on this server.",
        NOT_GRANTED_HINT,
      );
    }
    const ids = holfuyStationIds();
    if (ids.length === 0) {
      return failure(
        "unsupported",
        "No Holfuy station is configured.",
        "Set HOLFUY_STATIONS to the station id you were granted access to, for example HOLFUY_STATIONS=1199 for OKK – Larkollen. Holfuy has no public station directory, so the app cannot look them up.",
      );
    }

    const notes: string[] = [];
    const stations: StationRef[] = [];
    for (const id of ids) {
      const res = await fetchJson(`${API}/live/?s=${encodeURIComponent(id)}&m=JSON&su=m/s&tu=C&pw=${encodeURIComponent(key)}`);
      let name = `Holfuy ${id}`;
      if (res.ok && isRecord(res.json)) {
        const refused = archiveFailure(res.json);
        if (refused) {
          notes.push(`Station ${id}: ${refused.error}`);
        } else if (typeof res.json.stationName === "string" && res.json.stationName.trim()) {
          name = res.json.stationName.trim();
        }
      }
      stations.push({
        providerId: "holfuy",
        id,
        name,
        // Holfuy's API exposes no coordinates, and inventing them would fake the distance ranking.
        lat: null,
        lon: null,
        elevationM: null,
        distanceKm: null,
        elements: ["wind_speed", "wind_direction", "wind_gust"],
        reasons: [
          "Holfuy stations usually sit at the spot itself, which is why they beat a distant official station when one is available.",
        ],
        score: 1,
        hasWind: true,
        hasDirection: true,
        quality: "measured",
      } as StationRef);
    }
    notes.push(
      "Holfuy's API reports no coordinates, so these stations carry no distance. That is a gap in their API, not a guess made here.",
    );
    return success(stations, notes);
  },

  async fetchObservations({ stationId, from, to }) {
    const key = holfuyKey();
    if (!key) {
      return failure("no_key", "Holfuy is not configured on this server.", NOT_GRANTED_HINT);
    }
    if (!holfuyStationIds().includes(stationId)) {
      return failure(
        "unsupported",
        `Station ${stationId} is not in HOLFUY_STATIONS.`,
        "Add it there if your Holfuy password covers it. Only the stations you were granted are reachable.",
      );
    }

    // A day either side of the session: the API takes whole UTC dates, and the window is widened so
    // an evening session near midnight cannot fall outside a single day.
    const url =
      `${API}/archive/?s=${encodeURIComponent(stationId)}` +
      `&start_date=${ymd(from - 24 * 3600_000)}&stop_date=${ymd(to + 24 * 3600_000)}` +
      `&su=m/s&tu=C&utc&m=JSON&pw=${encodeURIComponent(key)}`;
    const res = await fetchJson(url, {}, 20_000);
    if (!res.ok) return res;

    const refused = archiveFailure(res.json);
    if (refused) return failure("no_key", refused.error, refused.hint);

    const samples = parseHolfuyArchive(res.json, stationId);
    if (samples.length === 0) {
      return failure(
        "empty",
        "Holfuy returned no archive rows for that session's dates.",
        "Holfuy may hold no archive for the station over those dates, or the station may report at a coarser resolution than the session. Nothing has been invented to fill the gap — use another station or enter the wind manually.",
      );
    }
    return success(samples, [
      `Holfuy archive: ${samples.length} averaged rows. Querying by date returns Holfuy's averaged rows rather than raw readings, so short-lived variations inside each row are not visible.`,
    ]);
  },
};
