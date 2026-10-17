/** Unit conversions and display formatting. */

export const MPS_TO_KNOTS = 1.9438444924406;
export const MPS_TO_KMH = 3.6;

export type SpeedUnit = "kn" | "mps" | "kmh";

export const SPEED_UNIT_LABEL: Record<SpeedUnit, string> = {
  kn: "kn",
  mps: "m/s",
  kmh: "km/h",
};

export const SPEED_UNIT_LONG: Record<SpeedUnit, string> = {
  kn: "knots",
  mps: "metres per second",
  kmh: "km/h",
};

export function mpsToKnots(mps: number): number {
  return mps * MPS_TO_KNOTS;
}

export function mpsToKmh(mps: number): number {
  return mps * MPS_TO_KMH;
}

export function knotsToMps(kn: number): number {
  return kn / MPS_TO_KNOTS;
}

export function kmhToMps(kmh: number): number {
  return kmh / MPS_TO_KMH;
}

/** Convert a speed in m/s into the requested display unit. */
export function convertSpeed(mps: number, unit: SpeedUnit): number {
  switch (unit) {
    case "kn":
      return mpsToKnots(mps);
    case "kmh":
      return mpsToKmh(mps);
    case "mps":
      return mps;
  }
}

/** Convert a value expressed in `unit` back into m/s. */
export function toMps(value: number, unit: SpeedUnit): number {
  switch (unit) {
    case "kn":
      return knotsToMps(value);
    case "kmh":
      return kmhToMps(value);
    case "mps":
      return value;
  }
}

export function formatSpeed(
  mps: number | null | undefined,
  unit: SpeedUnit,
  digits = 1,
): string {
  if (mps == null || !Number.isFinite(mps)) return "—";
  const v = convertSpeed(mps, unit);
  const d = unit === "mps" ? Math.max(digits, 1) : digits;
  return v.toFixed(d);
}

export function formatNumber(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

/** Distance in metres rendered with sensible units. */
export function formatDistance(m: number | null | undefined, digits = 2): string {
  if (m == null || !Number.isFinite(m)) return "—";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(digits)} km`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatDurationLong(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m} min`;
}

export const COMPASS_POINTS = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** 16-point compass name for a direction. */
export function compassPoint(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return "—";
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_POINTS[idx];
}

/** "W 285°" style label for a meteorological direction. */
export function formatDirection(deg: number | null | undefined): string {
  if (deg == null || !Number.isFinite(deg)) return "—";
  const d = Math.round((((deg % 360) + 360) % 360));
  return `${compassPoint(d)} ${String(d).padStart(3, "0")}°`;
}

/**
 * Format an instant in a fixed UTC offset. Used because a session must always display in the
 * timezone it was recorded in, regardless of where the user opens the app.
 */
export function formatTimeInOffset(t: number, offsetMin: number | null, withSeconds = false): string {
  const shifted = t + (offsetMin ?? -new Date(t).getTimezoneOffset()) * 60_000;
  const d = new Date(shifted);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return withSeconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

export function formatDateInOffset(t: number, offsetMin: number | null): string {
  const shifted = t + (offsetMin ?? -new Date(t).getTimezoneOffset()) * 60_000;
  const d = new Date(shifted);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** ISO-like local string with an explicit offset, e.g. 2025-06-14T12:03:00+02:00 */
export function isoWithOffset(t: number, offsetMin: number | null): string {
  const off = offsetMin ?? -new Date(t).getTimezoneOffset();
  const shifted = new Date(t + off * 60_000);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const ohh = String(Math.floor(abs / 60)).padStart(2, "0");
  const omm = String(abs % 60).padStart(2, "0");
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}` +
    `${sign}${ohh}:${omm}`
  );
}

export function formatOffset(offsetMin: number | null): string {
  if (offsetMin == null) return "browser local time";
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
