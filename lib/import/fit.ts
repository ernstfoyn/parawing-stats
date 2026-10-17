import { Decoder, Stream } from "@garmin/fitsdk";
import { normalize360 } from "../geo";
import type { ActivityFormat, RawActivityMeta, RawSample, TimeRange } from "../types";
import {
  ImportError,
  SEMICIRCLE_TO_DEG,
  num,
  summariseChannels,
  toEpochMs,
  type ParsedActivity,
} from "./types";

/**
 * FIT reader, built on Garmin's own JavaScript SDK.
 *
 * FIT is the format Garmin Connect, Strava and most watches actually write, and it carries things
 * GPX does not: device-reported speed (Doppler derived, much cleaner than differentiating
 * position), timer pause events, and the original activity sport.
 *
 * The decoder is configured to apply the profile's scale/offset, expand sub-fields and components
 * (so `enhancedSpeed` and merged heart-rate data are present) and to keep type values as strings.
 */

/** `record` message numbers as they appear in the SDK's generated message classes. */
type FitRecord = Record<string, unknown>;

export function parseFit(bytes: ArrayBuffer, fileName = "activity.fit"): ParsedActivity {
  const stream = Stream.fromArrayBuffer(bytes);
  if (!Decoder.isFIT(stream)) {
    throw new ImportError(
      "This file is not a FIT file (the header signature is missing).",
      "If it came from Garmin Connect, export it again as a .fit or .gpx file.",
    );
  }

  const decoder = new Decoder(stream);
  const integrity = decoder.checkIntegrity();
  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandComponents: true,
    expandSubFields: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: true,
  });

  const warnings: string[] = [];
  if (!integrity) {
    warnings.push("The FIT file failed its CRC integrity check; the data may be truncated.");
  }
  for (const err of errors ?? []) {
    const message = typeof err === "string" ? err : err?.message;
    if (message) warnings.push(`FIT decoder: ${message}`);
  }

  const records = (messages.recordMesgs ?? []) as FitRecord[];
  if (records.length === 0) {
    throw new ImportError(
      "The FIT file contains no record messages, so there is no track to analyse.",
      "Files exported as 'course' or 'workout' have no recorded positions.",
    );
  }

  const samples: RawSample[] = [];
  let missingPosition = 0;
  let missingTime = 0;

  for (const rec of records) {
    const t = toEpochMs(rec.timestamp);
    if (t == null) {
      missingTime++;
      continue;
    }
    const lat = toDegrees(rec.positionLat);
    const lon = toDegrees(rec.positionLong);
    if (lat == null || lon == null) {
      missingPosition++;
      continue;
    }
    samples.push({
      t,
      lat,
      lon,
      ele: pick(rec, ["enhancedAltitude", "altitude"]),
      hr: sanitiseHeartRate(pick(rec, ["heartRate"])),
      speed: nonNegative(pick(rec, ["enhancedSpeed", "speed"])),
      cog: courseOf(rec),
      deviceDistance: nonNegative(pick(rec, ["distance"])),
    });
  }

  if (samples.length === 0) {
    throw new ImportError(
      "No record in this FIT file has both a position and a timestamp.",
      missingPosition > 0
        ? "The activity appears to have been recorded without GPS (indoor or GPS off)."
        : null,
    );
  }
  if (missingPosition > 0) {
    warnings.push(
      `${missingPosition} record(s) had no GPS position (typical when the watch has not got a fix yet) and were skipped.`,
    );
  }
  if (missingTime > 0) {
    warnings.push(`${missingTime} record(s) had no timestamp and were skipped.`);
  }

  const session = first(messages.sessionMesgs) as FitRecord | null;
  const fileId = first(messages.fileIdMesgs) as FitRecord | null;
  const deviceInfo = (messages.deviceInfoMesgs ?? []) as FitRecord[];
  const sport = sportName(session);

  const device =
    firstNonEmpty(
      deviceInfo.map((d) => textValue(d.productName)),
    ) ??
    firstNonEmpty([textValue(fileId?.product), textValue(fileId?.manufacturer)]) ??
    null;

  const pauses = extractPauses((messages.eventMesgs ?? []) as FitRecord[]);
  if (pauses.length > 0) {
    warnings.push(
      `The recording was paused ${pauses.length} time(s); those intervals are excluded from moving time.`,
    );
  }

  if (!summariseChannels(samples).speed) {
    warnings.push(
      "The FIT file has no device speed, so speed is derived from GPS positions (less accurate at low speed).",
    );
  }

  const timezoneOffsetMin = timezoneOffsetFromSession(session);
  if (timezoneOffsetMin != null) {
    warnings.push(
      `The device recorded a local UTC offset of ${timezoneOffsetMin > 0 ? "+" : ""}${(timezoneOffsetMin / 60).toFixed(timezoneOffsetMin % 60 === 0 ? 0 : 1)} h.`,
    );
  }

  const meta: RawActivityMeta = {
    format: "fit" as ActivityFormat,
    fileName,
    fileHash: "",
    sport,
    device,
    creator: textValue(fileId?.manufacturer) ?? null,
    timerStart: toEpochMs(session?.startTime) ?? samples[0].t,
    timerEnd: samples[samples.length - 1].t,
    pauses,
    timezoneOffsetMin,
    has: summariseChannels(samples),
    warnings,
  };

  return { samples, meta };
}

/** Semicircles → degrees. */
function toDegrees(value: unknown): number | null {
  const raw = num(value);
  if (raw == null) return null;
  const deg = raw * SEMICIRCLE_TO_DEG;
  if (!Number.isFinite(deg) || Math.abs(deg) > 180) return null;
  return deg;
}

function pick(rec: FitRecord, keys: string[]): number | null {
  for (const key of keys) {
    const v = num(rec[key]);
    if (v != null) return v;
  }
  return null;
}

function nonNegative(v: number | null): number | null {
  if (v == null) return null;
  return v >= 0 ? v : null;
}

function sanitiseHeartRate(v: number | null): number | null {
  if (v == null || v <= 0 || v > 250) return null;
  return Math.round(v);
}

/** Some devices record a course/heading channel in degrees. */
function courseOf(rec: FitRecord): number | null {
  const deg = pick(rec, ["heading", "course"]);
  if (deg == null) return null;
  return normalize360(deg);
}

function first<T>(arr: T[] | undefined): T | null {
  return arr && arr.length > 0 ? arr[0] : null;
}

function firstNonEmpty(values: (string | null | undefined)[]): string | null {
  for (const v of values) if (v) return v;
  return null;
}

function textValue(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

/** Friendly sport label from the FIT session message. */
function sportName(session: FitRecord | null): string | null {
  if (!session) return null;
  const sport = textValue(session.sport);
  const sub = textValue(session.subSport);
  if (sport && sub && sub !== "generic") return `${sport} (${sub})`;
  return sport;
}

/**
 * Timer pauses. Garmin writes `event` messages with event=timer and eventType stop_all / start,
 * which is exactly what we need to exclude a rest on the beach from the moving time.
 */
export function extractPauses(events: FitRecord[]): TimeRange[] {
  const pauses: TimeRange[] = [];
  let open: number | null = null;
  for (const ev of events) {
    if (ev.event !== "timer") continue;
    const type = textValue(ev.eventType);
    if (!type) continue;
    const t = toEpochMs(ev.timestamp);
    if (t == null) continue;
    if (type.startsWith("stop")) {
      if (open == null) open = t;
    } else if (type.startsWith("start")) {
      if (open != null) {
        pauses.push({ start: open, end: t });
        open = null;
      }
    }
  }
  return pauses.filter((p) => p.end != null && p.end > p.start);
}

/**
 * Garmin records the activity's local UTC offset in a `time_zone_offset` developer field on the
 * session message. It is not part of the standard profile, so it is only used when present.
 */
function timezoneOffsetFromSession(session: FitRecord | null): number | null {
  if (!session) return null;
  for (const key of ["timeZoneOffset", "time_zone_offset"]) {
    const v = num(session[key]);
    if (v != null && Math.abs(v) <= 14 * 3600) return Math.round(v / 60);
  }
  return null;
}
