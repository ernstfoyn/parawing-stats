import type { RawActivityMeta, RawSample } from "../types";

/** Result of reading a .fit or .gpx file. */
export interface ParsedActivity {
  samples: RawSample[];
  meta: RawActivityMeta;
}

/** Errors that should be shown to the user verbatim. */
export class ImportError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = "ImportError";
    this.hint = hint;
  }
}

/** FIT timestamps count seconds from 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_MS = 631065600000;

/**
 * FIT stores coordinates in "semicircles": a signed 32-bit integer covering 180 degrees.
 * The SDK does not apply this scale, so it is done here.
 */
export const SEMICIRCLE_TO_DEG = 180 / 2147483648;

export function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Guard against files where the decoder left the raw value in place. Unix seconds are always
    // larger than 1.5e9 for dates after 2017; FIT seconds are around 1.1e9 for the 2020s.
    if (value > 1.5e9) return value * 1000;
    if (value > 1e8) return FIT_EPOCH_MS + value * 1000;
    return null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Build the `has` block of the metadata from the parsed samples. */
export function summariseChannels(samples: readonly RawSample[]): RawActivityMeta["has"] {
  let speed = false;
  let hr = false;
  let ele = false;
  let cog = false;
  let distance = false;
  for (const s of samples) {
    if (s.speed != null) speed = true;
    if (s.hr != null) hr = true;
    if (s.ele != null) ele = true;
    if (s.cog != null) cog = true;
    if (s.deviceDistance != null) distance = true;
  }
  return { speed, hr, ele, cog, distance };
}
