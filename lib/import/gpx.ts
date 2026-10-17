import { XMLParser } from "fast-xml-parser";
import type { ActivityFormat, RawActivityMeta, RawSample, TimeRange } from "../types";
import { ImportError, num, summariseChannels, type ParsedActivity } from "./types";

/**
 * GPX 1.1 reader.
 *
 * Handles the dialects that actually show up in the wild: Garmin Connect exports
 * (`gpxtpx:TrackPointExtension` with hr/cad/atemp), Strava exports, and plain
 * `<trkpt><ele><time> tracks. Namespace prefixes are stripped so `gpxtpx:hr` and `hr` are the
 * same key, and every numeric field is looked for by name in the point's subtree.
 */

interface GpxNode {
  [key: string]: unknown;
}

const ARRAY_TAGS = new Set(["trk", "trkseg", "trkpt", "rte", "rtept", "wpt", "extensions"]);

export function parseGpx(text: string, fileName = "activity.gpx"): ParsedActivity {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => ARRAY_TAGS.has(name),
    allowBooleanAttributes: true,
  });

  let doc: GpxNode;
  try {
    doc = parser.parse(text) as GpxNode;
  } catch (err) {
    throw new ImportError(
      "The GPX file could not be parsed as XML.",
      err instanceof Error ? err.message : null,
    );
  }

  const gpx = (doc.gpx ?? doc) as GpxNode;
  const looksLikeGpx = "gpx" in doc || "trk" in doc || "rte" in doc || "wpt" in doc;
  if (!looksLikeGpx) {
    throw new ImportError("This file does not look like GPX — no <gpx> element was found.");
  }
  const root = typeof gpx === "object" && gpx !== null ? gpx : ({} as GpxNode);

  const warnings: string[] = [];
  const samples: RawSample[] = [];
  const pauses: TimeRange[] = [];
  let timezoneOffsetMin: number | null = null;
  let offsetNoted = false;

  const tracks = toArray<GpxNode>(root.trk);
  const routes = toArray<GpxNode>(root.rte);
  const waypoints = toArray<GpxNode>(root.wpt);

  let pointGroups: GpxNode[][] = [];
  if (tracks.length > 0) {
    for (const trk of tracks) {
      const segs = toArray<GpxNode>(trk.trkseg);
      if (segs.length === 0) {
        // Some writers put trkpt straight under trk.
        const direct = toArray<GpxNode>(trk.trkpt);
        if (direct.length) pointGroups.push(direct);
        continue;
      }
      for (const seg of segs) pointGroups.push(toArray<GpxNode>(seg.trkpt));
    }
  } else if (routes.length > 0) {
    warnings.push("This GPX file contains a route rather than a recorded track; times may be planned, not recorded.");
    for (const rte of routes) pointGroups.push(toArray<GpxNode>(rte.rtept));
  } else if (waypoints.length > 0) {
    warnings.push("This GPX file only contains waypoints — there is no continuous track to analyse.");
    pointGroups.push(waypoints);
  }

  pointGroups = pointGroups.filter((g) => g.length > 0);
  if (pointGroups.length === 0) {
    throw new ImportError("The GPX file contains no track points.");
  }
  if (pointGroups.length > 1) {
    warnings.push(
      `The file contains ${pointGroups.length} track segments; they are analysed in order and the time gaps between them are reported as interruptions.`,
    );
  }

  let lastT: number | null = null;
  for (const group of pointGroups) {
    let firstInGroup: number | null = null;
    let lastInGroup: number | null = null;

    for (const pt of group) {
      const lat = num(attr(pt, "lat"));
      const lon = num(attr(pt, "lon"));
      if (lat == null || lon == null) continue;

      const timeRaw = firstChild(pt, "time");
      const t = parseGpxTime(timeRaw);
      if (t == null) continue;

      if (!offsetNoted) {
        offsetNoted = true;
        const off = detectOffset(timeRaw);
        if (off != null && off !== 0) {
          timezoneOffsetMin = off;
          warnings.push(
            `Timestamps carry a UTC offset (${off > 0 ? "+" : ""}${Math.round(off / 60)}h). GPX is supposed to be UTC, so this file was written by a non-standard tool; the offset is preserved for display.`,
          );
        }
      }

      samples.push({
        t,
        lat,
        lon,
        ele: findNumber(pt, ["ele", "elevation", "altitude"]),
        hr: findNumber(pt, ["hr", "heartrate", "heartRate", "hrValue", "bpm"]),
        speed: findNumber(pt, ["speed", "spd", "velocity"]),
        cog: findNumber(pt, ["course", "bearing", "heading", "cog", "direction"]),
        deviceDistance: findNumber(pt, ["distance", "dist", "odometer"]),
      });

      if (firstInGroup == null) firstInGroup = t;
      lastInGroup = t;
    }

    if (firstInGroup != null && lastT != null && firstInGroup > lastT) {
      pauses.push({ start: lastT, end: firstInGroup });
    }
    if (lastInGroup != null) lastT = lastInGroup;
  }

  if (samples.length === 0) {
    throw new ImportError(
      "No track point in this GPX file has both a position and a timestamp.",
      "Parawing stats needs time-stamped positions to compute speeds and wind angles.",
    );
  }

  const meta: RawActivityMeta = {
    format: "gpx" as ActivityFormat,
    fileName,
    fileHash: "",
    sport: findText(root, ["type", "sport"]) ?? null,
    device: findText(root, ["name"]) ?? null,
    creator: findText(root, ["creator"]) ?? null,
    timerStart: samples[0].t,
    timerEnd: samples[samples.length - 1].t,
    pauses,
    timezoneOffsetMin,
    has: summariseChannels(samples),
    warnings,
  };

  if (!meta.has.speed) {
    warnings.push("No speed channel is present, so speed is derived from GPS positions.");
  }
  if (!meta.has.hr) {
    warnings.push("No heart rate channel is present in this file.");
  }

  return { samples, meta };
}

function attr(node: GpxNode, name: string): unknown {
  return node[`@_${name}`];
}

function toArray<T>(value: unknown): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}

/** First direct child with this tag name (arrays are unwrapped). */
function firstChild(node: GpxNode, name: string): unknown {
  const v = node[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Depth-first search for the first numeric value under one of `names`. This is how the
 * hr/cad/speed values inside `extensions` are found without hard-coding namespaces.
 */
function findNumber(node: GpxNode, names: string[], depth = 0): number | null {
  if (node == null || depth > 6 || typeof node !== "object") return null;
  for (const name of names) {
    if (name in node) {
      const v = firstChild(node as GpxNode, name);
      const n = num(v);
      if (n != null) return n;
    }
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const found = findNumber(value as GpxNode, names, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

function findText(node: GpxNode, names: string[], depth = 0): string | null {
  if (node == null || depth > 4 || typeof node !== "object") return null;
  for (const name of names) {
    if (name in node) {
      const v = firstChild(node as GpxNode, name);
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (value && typeof value === "object" && !key.startsWith("@_")) {
      const found = findText(value as GpxNode, names, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** GPX times are ISO-8601 UTC. Some tools emit a naive local time; treat those as UTC. */
export function parseGpxTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const normalized = hasZone ? raw : `${raw}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

/** Minutes east of UTC when the timestamp string carries an explicit offset. */
function detectOffset(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}
