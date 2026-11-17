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
 * **When no password is available** — which is the normal case, since every Norwegian station answers
 * `no_access` — there is a second route: Holfuy publishes each station's own graph data as a plain
 * JavaScript file on the public station page,
 *
 *   https://holfuy.com/dynamic/graphs/tdarr<id>.js
 *
 * with timestamps, wind speed, gust, minimum and direction for roughly the last five days at fifteen
 * minutes. No password, no key, nothing hidden. It is not their documented API and it may change
 * without notice, so it is a fallback and it says so; the coverage limit (about five days) is reported
 * rather than silently producing empty wind for an older session.
 *
 * Two details of that file had to be measured rather than assumed, and both were:
 *  - speeds are in **km/h**, not m/s: the file's maximum over five days is 65, and 65 m/s would be a
 *    hurricane while 65 km/h is an ordinary November gale on the Oslofjord;
 *  - timestamps are in the station's **local** time: the newest point read 10:19 while UTC read 09:23
 *    and Oslo read 10:23.
 *
 * Configuration:
 *   HOLFUY_API_KEY   optional: the API password, if access was ever granted
 *   HOLFUY_STATIONS  comma-separated station ids, e.g. "1542" for Rolfstangen LBK
 *
 * Resolution: querying by date returns Holfuy's averaged rows rather than raw readings (their
 * documentation: giving `start_date` forces the averaged type). The app reports how many observations
 * it actually got and over what share of the track, so the resolution is visible rather than assumed.
 */

import type { StationRef, WindSample } from "../../types";
import { failure, fetchJson, fetchText, isRecord, success, type ServerProvider } from "./types";

const API = "https://api.holfuy.com";
const API_PAGE = "https://holfuy.com";

/** The station name out of a page title like "Holfuy: Rolfstangen LBK, wind & weather report". */
function pageTitle(html: unknown): string | null {
  if (typeof html !== "string") return null;
  const m = html.match(/<title>\s*Holfuy:\s*([^,<]+)/i);
  return m ? m[1].trim() : null;
}

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

/** One station's public graph data, as published on its page. */
export interface HolfuyPublicSeries {
  /** local timestamps as written, e.g. "2026/11/17 10:19:30" */
  times: string[];
  /** km/h, as published */
  speedKmh: (number | null)[];
  gustKmh: (number | null)[];
  dirFromDeg: (number | null)[];
  tempC: (number | null)[];
}

/**
 * Parse one of the file's timestamps, which are written `2026/11/17 10:19:30`.
 *
 * Slashes make it non-ISO, and `Date.parse` is not obliged to read that — it returns NaN in Node, which
 * silently emptied every session. Normalised to ISO first, and treated as if it were UTC so the caller
 * can subtract the station's offset.
 */
function localEpoch(raw: string): number | null {
  const iso = raw.trim().replace(/\//g, "-").replace(" ", "T");
  const t = Date.parse(`${iso}Z`);
  return Number.isFinite(t) ? t : null;
}

/** Read the `var x = [...]` arrays out of a Holfuy station data file. */
export function parseHolfuyPublicFile(text: string): HolfuyPublicSeries | null {
  const arrays = new Map<string, unknown[]>();
  for (const m of text.matchAll(/var\s+(\w+)\s*=\s*(\[[\s\S]*?\])\s*;/g)) {
    const body = m[2]
      .slice(1, -1)
      .split(",")
      .map((v) => v.trim().replace(/^'|'$/g, ""))
      .filter((v) => v.length > 0);
    arrays.set(m[1], body);
  }
  const times = arrays.get("unt");
  if (!times || times.length === 0) return null;

  const num = (name: string): (number | null)[] => {
    const raw = arrays.get(name) ?? [];
    return times.map((_, i) => {
      const v = raw[i];
      if (v == null) return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    });
  };

  return {
    times: times.map((t) => String(t)),
    speedKmh: num("gd_speed"),
    gustKmh: num("gd_gust"),
    dirFromDeg: num("gd_direction"),
    tempC: num("gd_temp"),
  };
}

/**
 * The local-time offset of a series, in minutes east of UTC.
 *
 * Derived from the newest point against the clock rather than assumed: the file is in local time and
 * the offset changes with daylight saving, so hardcoding +1 would put a summer session two hours out.
 * Rounded to whole hours, and only trusted when it is a plausible offset; a stale station whose newest
 * point is hours old would otherwise produce a nonsense number.
 */
export function seriesOffsetMin(series: HolfuyPublicSeries, now = Date.now()): number | null {
  const last = series.times[series.times.length - 1];
  if (!last) return null;
  const asUtc = localEpoch(last);
  if (asUtc == null) return null;
  // The newest point read as if it were UTC sits *ahead* of the real clock by exactly the station's
  // offset east of UTC, so the difference is taken that way round.
  const minutes = Math.round((asUtc - now) / 60_000 / 60) * 60;
  return Math.abs(minutes) <= 14 * 60 ? minutes : null;
}

/** Turn a public series into samples inside a session window. */
export function holfuySamplesFromSeries(
  series: HolfuyPublicSeries,
  offsetMin: number,
  from: number,
  to: number,
  stationId: string,
): WindSample[] {
  const out: WindSample[] = [];
  for (let i = 0; i < series.times.length; i++) {
    const local = localEpoch(series.times[i]);
    if (local == null) continue;
    const t = local - offsetMin * 60_000;
    if (t < from || t > to) continue;
    const kmh = (v: number | null) => (v == null ? null : v / 3.6);
    out.push({
      t,
      speedMps: kmh(series.speedKmh[i] ?? null),
      gustMps: kmh(series.gustKmh[i] ?? null),
      dirFromDeg: series.dirFromDeg[i] ?? null,
      tempC: series.tempC[i] ?? null,
      quality: "measured",
      providerId: "holfuy",
      stationId,
    });
  }
  return out.sort((a, b) => a.t - b.t);
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
    const ids = holfuyStationIds();
    if (ids.length === 0) {
      return failure(
        "unsupported",
        "No Holfuy station is configured.",
        "Set HOLFUY_STATIONS to the station ids to watch, for example HOLFUY_STATIONS=1542 for Rolfstangen LBK. Holfuy has no public station directory, so the app cannot look them up.",
      );
    }

    const notes: string[] = [];
    const stations: StationRef[] = [];
    for (const id of ids) {
      // With a password, the documented live API gives the name. Without one, the public station page
      // does — it is the same station, read the same way its own website reads it.
      let name = `Holfuy ${id}`;
      if (key) {
        const res = await fetchJson(
          `${API}/live/?s=${encodeURIComponent(id)}&m=JSON&su=m/s&tu=C&pw=${encodeURIComponent(key)}`,
        );
        if (res.ok && isRecord(res.json)) {
          const refused = archiveFailure(res.json);
          if (refused) notes.push(`Station ${id}: ${refused.error}`);
          else if (typeof res.json.stationName === "string" && res.json.stationName.trim()) {
            name = res.json.stationName.trim();
          }
        }
      } else {
        const page = await fetchText(`${API_PAGE}/en/weather/${encodeURIComponent(id)}`, {}, 15_000);
        if (page.ok) {
          const title = pageTitle(page.text);
          if (title) name = title;
          notes.push(
            `Station ${id} is read from its public station page, because Holfuy's API answers no_access for it.`,
          );
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
    if (!key) {
      notes.push(
        "Without an API password the observations come from the station's public page, which publishes about five days at fifteen minutes. A session older than that will report no wind rather than a stale one.",
      );
    }
    return success(stations, notes);
  },

  async fetchObservations({ stationId, from, to }) {
    const key = holfuyKey();
    if (!holfuyStationIds().includes(stationId)) {
      return failure(
        "unsupported",
        `Station ${stationId} is not in HOLFUY_STATIONS.`,
        "Add it there if your Holfuy password covers it. Only the stations you were granted are reachable.",
      );
    }

    if (!key) {
      const res = await fetchText(`${API_PAGE}/dynamic/graphs/tdarr${encodeURIComponent(stationId)}.js`, {}, 20_000);
      if (!res.ok) return res;
      const series = parseHolfuyPublicFile(res.text);
      if (!series) {
        return failure(
          "empty",
          "Holfuy's public station page did not return any data for that station.",
          "The page may have changed, or the station id may be wrong. Nothing has been invented to fill the gap.",
        );
      }
      const offsetMin = seriesOffsetMin(series);
      if (offsetMin == null) {
        return failure(
          "upstream",
          "Could not work out which timezone the station's public data is in.",
          "The file is in the station's local time and the newest point was too old to calibrate against the clock, so the readings cannot be placed on your session's timeline. Nothing has been guessed.",
        );
      }
      const samples = holfuySamplesFromSeries(series, offsetMin, from, to, stationId);
      if (samples.length === 0) {
        return failure(
          "empty",
          "That station's public page does not reach back to this session.",
          "Holfuy publishes roughly five days of history per station. For an older session there is no wind here rather than wind from the wrong day.",
        );
      }
      return success(samples, [
        `Read from Holfuy's public station page: ${samples.length} points at fifteen minutes, in the station's local time (UTC${offsetMin >= 0 ? "+" : "-"}${Math.abs(offsetMin / 60)}), converted from km/h.`,
      ]);
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
