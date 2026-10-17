/**
 * Core domain types for Parawing stats.
 *
 * Conventions used everywhere in the codebase:
 *  - Distances are metres, speeds are m/s, times are epoch milliseconds (UTC).
 *  - Angles are degrees, wind directions are *meteorological* (the direction the wind blows FROM),
 *    headings are the direction of travel (towards).
 *  - `null` always means "not measured". Nothing in this app fabricates a missing measurement.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** A single sample as read from a file, before any cleaning. */
export interface RawSample {
  /** epoch ms, UTC */
  t: number;
  lat: number;
  lon: number;
  /** speed as reported by the device, m/s. null when the file has no speed. */
  speed: number | null;
  /** barometric or GPS altitude, m */
  ele: number | null;
  /** heart rate, bpm */
  hr: number | null;
  /** course over ground as reported by the device, degrees true */
  cog: number | null;
  /** device-reported cumulative distance, m (used only for cross-checking) */
  deviceDistance: number | null;
}

export type ActivityFormat = "fit" | "gpx";

export interface TimeRange {
  start: number;
  end: number | null;
}

export interface RawActivityMeta {
  format: ActivityFormat;
  fileName: string;
  /** sha-256 of the raw file bytes, used to prevent duplicate imports */
  fileHash: string;
  sport: string | null;
  device: string | null;
  creator: string | null;
  /**
   * The activity's own name as the file recorded it, e.g. "Rygge SUP-surfing".
   *
   * This is what a Garmin puts in `<trk><name>` and a FIT session carries in its name field, and it
   * is the only place a GPS file says *where* the rider was. It is kept verbatim: turning it into a
   * place name is `lib/naming.ts`'s job, and that must be able to decline.
   */
  title: string | null;
  /** timer start/stop from the device, when available */
  timerStart: number | null;
  timerEnd: number | null;
  /** intervals where the recording was paused (device timer stopped) */
  pauses: TimeRange[];
  /** minutes east of UTC when the file advertised a local offset */
  timezoneOffsetMin: number | null;
  /** which channels the file actually contains */
  has: {
    speed: boolean;
    hr: boolean;
    ele: boolean;
    cog: boolean;
    distance: boolean;
  };
  /** human readable notes about smells in the file (missing channels, odd timestamps, ...) */
  warnings: string[];
}

/** A cleaned, normalised track point. Derived metrics live alongside the raw values. */
export interface TrackPoint {
  t: number;
  lat: number;
  lon: number;
  ele: number | null;
  hr: number | null;
  /** m/s. Device value when present, otherwise derived from displacement / dt. */
  speed: number | null;
  /** true when `speed` came from the device rather than being derived. */
  speedFromDevice: boolean;
  /** degrees true, from displacement when the device did not provide one */
  cog: number | null;
  /** cumulative distance from the first kept point, m */
  dist: number;
  /** seconds since the previous point (0 for the first point) */
  dt: number;
  /** metres since the previous point (0 for the first point) */
  dd: number;
  /** true when this point is part of moving time */
  moving: boolean;
  /** true when dt exceeds the session's gap threshold (pause or lost signal) */
  gap: boolean;
}

export interface CleanupReport {
  totalRaw: number;
  kept: number;
  droppedInvalidPosition: number;
  droppedDuplicateTimestamp: number;
  droppedSpeedSpike: number;
  droppedOutOfOrder: number;
  droppedGpsJump: number;
  /** samples removed because a device timer pause covered them */
  droppedPaused: number;
  /** number of gaps between kept points longer than the gap threshold */
  gaps: number;
  /** longest gap in seconds */
  longestGapS: number;
  /** offset (minutes east of UTC) inferred from the file, if it advertised one */
  timezoneOffsetMin: number | null;
  notes: string[];
}

/* ------------------------------------------------------------------ wind */

export type WindQuality = "measured" | "modelled" | "manual";

export interface WindSample {
  /** epoch ms UTC */
  t: number;
  /** m/s */
  speedMps: number | null;
  /** m/s */
  gustMps: number | null;
  /** meteorological direction, degrees the wind comes FROM */
  dirFromDeg: number | null;
  /** air temperature, °C, when the source provides it */
  tempC?: number | null;
  quality: WindQuality;
  providerId: string;
  stationId: string | null;
}

export type ProviderId = "frost" | "open-meteo" | "holfuy";

export type WindSourceKind = ProviderId | "manual" | "none";

export interface StationRef {
  providerId: string;
  /** provider specific station id, e.g. Frost "SN50540" */
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  elevationM: number | null;
  /** great-circle distance from the activity centroid, km */
  distanceKm: number | null;
  /** how many of the requested elements the station actually reports */
  elements: string[];
  /** free-text description of why this station is a good/bad candidate */
  reasons: string[];
  /** 0..1 heuristic ranking score (coastal + good coverage + close) */
  score: number;
  /** true when the station advertises wind observations */
  hasWind: boolean;
  /**
   * true when the station also reports wind *direction*. Without it there is no true wind angle,
   * no VMG and no way to separate a downwind run from an upwind beat, so a speed-only station is a
   * much weaker candidate.
   */
  hasDirection: boolean;
}

export interface ManualWind {
  speedMps: number;
  dirFromDeg: number;
  gustMps: number | null;
}

export interface WindModel {
  kind: WindSourceKind;
  station: StationRef | null;
  manual: ManualWind | null;
  /** max seconds between a track point and the closest observation before wind is treated as missing */
  maxGapS: number;
  /** when true, linearly interpolate between observations; otherwise use the nearest one */
  interpolate: boolean;
}

export type WindInterp = "exact" | "interpolated" | "nearest" | "none";

/** Track point enriched with wind-derived values. */
export interface EnrichedPoint extends TrackPoint {
  windSpeedMps: number | null;
  windGustMps: number | null;
  windDirFromDeg: number | null;
  windQuality: WindQuality | null;
  windInterp: WindInterp;
  /** true wind angle, 0..180 (0 = head to wind, 180 = dead run). null without wind data. */
  twa: number | null;
  /** m/s, positive when making ground toward the wind source */
  vmgUpMps: number | null;
  /** m/s, positive when making ground away from the wind source */
  vmgDownMps: number | null;
}

/* -------------------------------------------------------------- segments */

export type SegmentLabel =
  | "upwind"
  | "reaching"
  | "idle"
  | "powered_downwind"
  | "free_downwind"
  | "unclassified"
  | "excluded";

export const SEGMENT_LABELS: SegmentLabel[] = [
  "upwind",
  "reaching",
  "idle",
  "powered_downwind",
  "free_downwind",
  "unclassified",
  "excluded",
];

/** Labels a rider can choose in the editor, in menu order. */
export const USER_LABELS: SegmentLabel[] = [
  "free_downwind",
  "powered_downwind",
  "upwind",
  "reaching",
  "idle",
  "unclassified",
  "excluded",
];

export interface SegmentFeatures {
  durationS: number;
  distanceM: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  /** mean true wind angle in degrees */
  avgTwaDeg: number;
  /** circular spread of the heading (0 = perfectly straight, 1 = all over the place) */
  headingSpread: number;
  avgVmgDownMps: number;
  /** fraction of samples with TWA > 150° (dead run) */
  deadRunFraction: number;
  /** fraction of samples that are actively moving */
  movingFraction: number;
  avgWindSpeedMps: number | null;
}

export interface Segment {
  id: string;
  startIdx: number;
  /** inclusive */
  endIdx: number;
  auto: {
    label: SegmentLabel;
    confidence: number;
    reasons: string[];
  };
  /** user assigned label; overrides `auto.label` when set */
  manualLabel: SegmentLabel | null;
  features: SegmentFeatures;
}

export interface SegmentPlan {
  segments: Segment[];
  /** bumped when the detection engine changes so stored plans can be flagged as stale */
  engineVersion: string;
}

export interface SegmentStats {
  count: number;
  distanceM: number;
  durationS: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  avgVmgDownMps: number | null;
  longest: {
    distanceM: number;
    durationS: number;
    avgSpeedMps: number;
    maxSpeedMps: number;
    startIdx: number;
    endIdx: number;
    id: string;
  } | null;
}

/* ------------------------------------------------------------- equipment */

export interface EquipmentProfile {
  id: string;
  name: string;
  parawingBrand: string;
  parawingModel: string;
  /** m² of the parawing */
  parawingSizeM2: number | null;
  foilModel: string;
  /** foil wing area or span label, free text (e.g. "M", "1100 cm²") */
  foilSize: string;
  stabilizer: string;
  boardModel: string;
  /** litres */
  boardVolumeL: number | null;
  notes: string;
}

export const EMPTY_EQUIPMENT: EquipmentProfile = {
  id: "equipment-empty",
  name: "",
  parawingBrand: "",
  parawingModel: "",
  parawingSizeM2: null,
  foilModel: "",
  foilSize: "",
  stabilizer: "",
  boardModel: "",
  boardVolumeL: null,
  notes: "",
};

/* -------------------------------------------------------------- sessions */

export interface SessionMetrics {
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  /** slowest non-zero speed percentile, used as a "stall" indicator */
  p10SpeedMps: number | null;
  startedAt: number;
  endedAt: number;
  speedBuckets: HistogramBucket[];
  speedCounts?: never;
}

export interface HistogramBucket {
  /** lower edge in m/s */
  fromMps: number;
  toMps: number;
  /** seconds spent in this bucket */
  timeS: number;
}

export interface DirectionStats {
  timeS: number;
  distanceM: number;
  avgSpeedMps: number | null;
  maxSpeedMps: number | null;
  avgVmgMps: number | null;
  bestVmgMps: number | null;
}

export interface SessionRecord {
  id: string;
  /** sha-256 of the source file, used for duplicate detection */
  fileHash: string;
  fileName: string;
  importedAt: number;
  name: string;
  format: ActivityFormat;
  sport: string | null;
  device: string | null;
  creator: string | null;
  /** the activity's own name from the file, e.g. "Rygge SUP-surfing" */
  title: string | null;
  startedAt: number;
  endedAt: number;
  /** minutes east of UTC used for display. null = use the browser timezone */
  timezoneOffsetMin: number | null;
  points: TrackPoint[];
  cleanup: CleanupReport;
  rawWarnings: string[];
  wind: WindModel;
  windSamples: WindSample[];
  /** provider id of a *cached* station list, so the picker does not need a network round trip */
  stationCache: StationRef[] | null;
  stationCacheAt: number | null;
  segments: SegmentPlan;
  equipment: EquipmentProfile;
  notes: string;
  demo: boolean;
  appVersion: string;
}

/** Lightweight list row, kept in a separate store so the overview page never loads tracks. */
export interface SessionSummary {
  id: string;
  fileHash: string;
  fileName: string;
  name: string;
  importedAt: number;
  startedAt: number;
  durationS: number;
  distanceM: number;
  maxSpeedMps: number | null;
  sport: string | null;
  equipmentName: string;
  windLabel: string;
  downwindDistanceM: number;
  demo: boolean;
  pointCount: number;
}
