/**
 * Session repository.
 *
 * Design for future cloud sync:
 *  - every session has a globally unique id and a content hash of the source file,
 *  - the immutable track data is stored separately from the editable metadata,
 *  - the summary rows are denormalised so the overview page never loads a track,
 *  - a single `updatedAt` timestamp per session is enough to build a sync diff later.
 */

import { cleanTrack } from "../clean";
import { buildDemoActivity, DEMO_EQUIPMENT } from "../demo";
import { buildSegmentPlan, downwindStats } from "../classify";
import { centroid } from "../geo";
import { readActivityFile } from "../import";
import { analyse } from "../pipeline";
import { alignWind } from "../wind/align";
import { EMPTY_EQUIPMENT } from "../types";
import type {
  CleanupReport,
  EquipmentProfile,
  SegmentPlan,
  SessionMetrics,
  SessionRecord,
  SessionSummary,
  StationRef,
  TrackPoint,
  WindModel,
  WindSample,
} from "../types";
import { describeWindSource } from "../summary";
import { getAll, get, getByIndex, put, remove, STORES } from "./db";

export const APP_VERSION = "1.0.0";

/** The parts of a session the rider can change after import. */
export interface SessionMeta {
  id: string;
  name: string;
  wind: WindModel;
  windSamples: WindSample[];
  stationCache: StationRef[] | null;
  stationCacheAt: number | null;
  segments: SegmentPlan;
  equipment: EquipmentProfile;
  notes: string;
  updatedAt: number;
}

/** The immutable part: the normalised track and what the importer/cleaner found. */
export interface StoredSession {
  id: string;
  fileHash: string;
  fileName: string;
  importedAt: number;
  format: "fit" | "gpx";
  sport: string | null;
  device: string | null;
  creator: string | null;
  startedAt: number;
  endedAt: number;
  timezoneOffsetMin: number | null;
  points: TrackPoint[];
  cleanup: CleanupReport;
  rawWarnings: string[];
  demo: boolean;
  appVersion: string;
  summary: SessionSummary;
}

export function newId(prefix = "ses"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Compose the full in-memory record from its stored halves. */
export function mergeSession(stored: StoredSession, meta: SessionMeta | null): SessionRecord {
  return {
    id: stored.id,
    fileHash: stored.fileHash,
    fileName: stored.fileName,
    importedAt: stored.importedAt,
    name: meta?.name ?? defaultName(stored),
    format: stored.format,
    sport: stored.sport,
    device: stored.device,
    creator: stored.creator,
    startedAt: stored.startedAt,
    endedAt: stored.endedAt,
    timezoneOffsetMin: stored.timezoneOffsetMin,
    points: stored.points,
    cleanup: stored.cleanup,
    rawWarnings: stored.rawWarnings,
    wind: meta?.wind ?? emptyWindModel(),
    windSamples: meta?.windSamples ?? [],
    stationCache: meta?.stationCache ?? null,
    stationCacheAt: meta?.stationCacheAt ?? null,
    segments: meta?.segments ?? buildSegmentPlan([]),
    equipment: meta?.equipment ?? EMPTY_EQUIPMENT,
    notes: meta?.notes ?? "",
    demo: stored.demo,
    appVersion: stored.appVersion,
  };
}

export function emptyWindModel(): WindModel {
  return { kind: "none", station: null, manual: null, maxGapS: 5400, interpolate: true };
}

function defaultName(stored: StoredSession): string {
  const date = new Date(stored.startedAt);
  const iso = date.toISOString().slice(0, 10);
  return stored.demo ? `Demo session ${iso}` : `${iso} ${stored.fileName.replace(/\.(fit|gpx)$/i, "")}`;
}

/** Build the storage halves for a freshly imported activity. */
export function buildStoredSession(input: {
  id: string;
  fileHash: string;
  fileName: string;
  format: "fit" | "gpx";
  sport: string | null;
  device: string | null;
  creator: string | null;
  timezoneOffsetMin: number | null;
  points: TrackPoint[];
  cleanup: CleanupReport;
  rawWarnings: string[];
  demo: boolean;
}): StoredSession {
  const points = input.points;
  const startedAt = points[0]?.t ?? Date.now();
  const endedAt = points[points.length - 1]?.t ?? startedAt;
  const analysis = analyse({
    points,
    windSamples: [],
    windModel: emptyWindModel(),
    rebuildSegments: true,
  });

  const stored: Omit<StoredSession, "summary"> = {
    id: input.id,
    fileHash: input.fileHash,
    fileName: input.fileName,
    importedAt: Date.now(),
    format: input.format,
    sport: input.sport,
    device: input.device,
    creator: input.creator,
    startedAt,
    endedAt,
    timezoneOffsetMin: input.timezoneOffsetMin,
    points,
    cleanup: input.cleanup,
    rawWarnings: input.rawWarnings,
    demo: input.demo,
    appVersion: APP_VERSION,
  };

  return { ...stored, summary: buildSummary(stored, null, analysis.metrics) };
}

export function buildSummary(
  stored: Omit<StoredSession, "summary"> | StoredSession,
  meta: SessionMeta | null,
  metrics?: SessionMetrics,
): SessionSummary {
  const plan = meta?.segments ?? buildSegmentPlan([]);
  // The same number the session's own Downwind panel reports: real runs only, never powered
  // reaches, and only stretches long enough to be a run. Reusing `downwindStats` keeps the list
  // card and the dashboard from ever drifting apart.
  const downwindDistanceM = downwindStats(plan).downwind.distanceM;

  const maxSpeed =
    metrics?.maxSpeedMps ??
    stored.points.reduce<number | null>((best, p) => (p.speed != null && (best == null || p.speed > best) ? p.speed : best), null);

  return {
    id: stored.id,
    fileHash: stored.fileHash,
    fileName: stored.fileName,
    name: meta?.name ?? defaultName(stored as StoredSession),
    importedAt: stored.importedAt,
    startedAt: stored.startedAt,
    durationS: (stored.endedAt - stored.startedAt) / 1000,
    distanceM: stored.points.length > 0 ? stored.points[stored.points.length - 1].dist : 0,
    maxSpeedMps: maxSpeed,
    sport: stored.sport,
    equipmentName: meta?.equipment.name ?? "",
    windLabel: describeWindSource(meta?.wind ?? emptyWindModel()),
    downwindDistanceM,
    demo: stored.demo,
    pointCount: stored.points.length,
  };
}

export function metaFromRecord(record: SessionRecord): SessionMeta {
  return {
    id: record.id,
    name: record.name,
    wind: record.wind,
    windSamples: record.windSamples,
    stationCache: record.stationCache,
    stationCacheAt: record.stationCacheAt,
    segments: record.segments,
    equipment: record.equipment,
    notes: record.notes,
    updatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ public API */

export async function saveSession(record: SessionRecord): Promise<void> {
  const stored = await get<StoredSession>(STORES.sessions, record.id);
  if (stored) {
    await updateSessionMeta(record);
    return;
  }
  const { summary: _summary, ...base } = record as SessionRecord & { summary?: unknown };
  void _summary;
  const baseRecord = base as unknown as Omit<StoredSession, "summary">;
  const analysis = analyse({
    points: record.points,
    windSamples: record.windSamples,
    windModel: record.wind,
    plan: record.segments,
  });
  const storedSession: StoredSession = {
    ...baseRecord,
    summary: buildSummary(baseRecord, metaFromRecord(record), analysis.metrics),
  };
  await put(STORES.sessions, storedSession as unknown as Record<string, unknown>);
  await put(STORES.meta, metaFromRecord(record) as unknown as Record<string, unknown>);
}

/** Write only the editable half. Called on every segment edit, so it stays small. */
export async function updateSessionMeta(record: SessionRecord): Promise<void> {
  const meta = metaFromRecord(record);
  const stored = await get<StoredSession>(STORES.sessions, record.id);
  if (!stored) return;
  const analysis = analyse({
    points: stored.points,
    windSamples: meta.windSamples,
    windModel: meta.wind,
    plan: meta.segments,
  });
  await put(STORES.meta, meta as unknown as Record<string, unknown>);
  await put(
    STORES.sessions,
    {
      ...stored,
      summary: buildSummary(stored, meta, analysis.metrics),
    } as unknown as Record<string, unknown>,
  );
}

export async function listSessions(): Promise<SessionSummary[]> {
  const [stored, metas] = await Promise.all([
    getAll<StoredSession>(STORES.sessions),
    getAll<SessionMeta>(STORES.meta),
  ]);
  const metaById = new Map(metas.map((m) => [m.id, m]));
  return stored
    .map((s) => {
      const meta = metaById.get(s.id) ?? null;
      return meta ? buildSummary(s, meta) : s.summary;
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  const stored = await get<StoredSession>(STORES.sessions, id);
  if (!stored) return null;
  const meta = await get<SessionMeta>(STORES.meta, id);
  return mergeSession(stored, meta);
}

export async function deleteSession(id: string): Promise<void> {
  await Promise.all([remove(STORES.sessions, id), remove(STORES.meta, id)]);
}

/** Duplicate detection: returns an existing session with the same file content. */
export async function findByHash(hash: string): Promise<SessionSummary | null> {
  const matches = await getByIndex<StoredSession>(STORES.sessions, "fileHash", hash);
  if (matches.length === 0) return null;
  return matches[0].summary;
}

/* ---------------------------------------------------------------- equipment presets */

const EQUIPMENT_KEY = "equipment-presets";

/** Presets the author actually rides, used as a starting point for new sessions. */
export const DEFAULT_EQUIPMENT_PRESETS: EquipmentProfile[] = [
  {
    ...EMPTY_EQUIPMENT,
    id: "preset-gong-plus-3",
    name: "Gong Plus V2 3 m²",
    parawingBrand: "Gong",
    parawingModel: "Plus V2",
    parawingSizeM2: 3,
  },
  {
    ...EMPTY_EQUIPMENT,
    id: "preset-gong-plus-4",
    name: "Gong Plus V2 4 m²",
    parawingBrand: "Gong",
    parawingModel: "Plus V2",
    parawingSizeM2: 4,
  },
  {
    ...EMPTY_EQUIPMENT,
    id: "preset-takoon-cloud-47",
    name: "Takoon Cloud 4.7 m²",
    parawingBrand: "Takoon",
    parawingModel: "Cloud",
    parawingSizeM2: 4.7,
  },
  {
    ...EMPTY_EQUIPMENT,
    id: "preset-gong-veloce-m-v3",
    name: "Gong Veloce M V3 foil",
    foilModel: "Gong Veloce M V3",
    foilSize: "M",
    stabilizer: "Gong Veloce M stabilizer",
  },
];

export async function loadEquipmentPresets(): Promise<EquipmentProfile[]> {
  const record = await get<{ key: string; presets: EquipmentProfile[] }>(
    STORES.settings,
    EQUIPMENT_KEY,
  );
  return record?.presets ?? DEFAULT_EQUIPMENT_PRESETS;
}

export async function saveEquipmentPresets(presets: EquipmentProfile[]): Promise<void> {
  await put(STORES.settings, { key: EQUIPMENT_KEY, presets } as unknown as Record<string, unknown>, "key");
}

/* ------------------------------------------------------------------- demo session */

/** The demo activity, as a session the rider can open, edit and delete like any other. */
export function demoSessionRecord(id = "demo-session"): SessionRecord {
  const demo = buildDemoActivity();
  const analysis = analyse({
    points: demo.points,
    windSamples: demo.windSamples,
    windModel: demo.windModel,
    rebuildSegments: true,
  });
  const startedAt = demo.points[0].t;
  const endedAt = demo.points[demo.points.length - 1].t;
  return {
    id,
    fileHash: "demo-synthetic-jaeren-2025-06-14",
    fileName: demo.meta.fileName,
    importedAt: Date.now(),
    name: "Demo: Jæren parawing session (synthetic)",
    format: "fit",
    sport: "windsurfing",
    device: "Garmin (synthetic demo)",
    creator: "synthetic",
    startedAt,
    endedAt,
    timezoneOffsetMin: 120,
    points: demo.points,
    cleanup: demo.report,
    rawWarnings: demo.meta.warnings,
    wind: demo.windModel,
    windSamples: demo.windSamples,
    stationCache: null,
    stationCacheAt: null,
    segments: analysis.plan,
    equipment: DEMO_EQUIPMENT,
    notes:
      "Synthetic demo data generated by Foil Analyzer: the GPS track is simulated and the wind is entered manually. Nothing here comes from a real session.",
    demo: true,
    appVersion: APP_VERSION,
  };
}

/** Clean + normalise an imported activity into storage halves. */
export function normaliseImport(input: {
  id: string;
  fileHash: string;
  fileName: string;
  format: "fit" | "gpx";
  sport: string | null;
  device: string | null;
  creator: string | null;
  samples: Parameters<typeof cleanTrack>[0];
  meta: Parameters<typeof cleanTrack>[1];
}): { stored: StoredSession; cleanup: CleanupReport } {
  const { points, report } = cleanTrack(input.samples, input.meta);
  const stored = buildStoredSession({
    id: input.id,
    fileHash: input.fileHash,
    fileName: input.fileName,
    format: input.format,
    sport: input.sport,
    device: input.device,
    creator: input.creator,
    timezoneOffsetMin: report.timezoneOffsetMin,
    points,
    cleanup: report,
    rawWarnings: input.meta?.warnings ?? [],
    demo: false,
  });
  return { stored, cleanup: report };
}

/** Convenience for the dashboard: re-align wind and rebuild the plan from a stored record. */
export function analyseSession(record: SessionRecord) {
  return analyse({
    points: record.points,
    windSamples: record.windSamples,
    windModel: record.wind,
    plan: record.segments,
  });
}

export function sessionCentroid(points: readonly TrackPoint[]): { lat: number; lon: number } | null {
  return centroid(points);
}

/* ------------------------------------------------------------------- importing */

export type ImportOutcome =
  | { status: "imported"; record: SessionRecord }
  | { status: "duplicate"; existing: SessionSummary };

/**
 * Read a rider-picked `.fit`/`.gpx` file, refuse it if the exact same bytes were imported before,
 * then clean, classify and persist it. Returns the record so the caller can navigate straight to
 * the dashboard.
 */
export async function importSessionFile(file: File): Promise<ImportOutcome> {
  const { parsed, hash } = await readActivityFile(file);

  const existing = await findByHash(hash);
  if (existing) return { status: "duplicate", existing };

  const id = newId();
  const { stored } = normaliseImport({
    id,
    fileHash: hash,
    fileName: file.name,
    format: parsed.meta.format,
    sport: parsed.meta.sport,
    device: parsed.meta.device,
    creator: parsed.meta.creator,
    samples: parsed.samples,
    meta: parsed.meta,
  });

  // Classify immediately (with no wind yet, so segments start honestly unclassified) and store the
  // plan in the editable half, so the dashboard opens with a plan it can edit.
  const record = mergeSession(stored, null);
  const analysis = analyse({
    points: record.points,
    windSamples: [],
    windModel: record.wind,
    rebuildSegments: true,
  });
  record.segments = analysis.plan;
  const meta = metaFromRecord(record);
  await put(STORES.sessions, {
    ...stored,
    summary: buildSummary(stored, meta, analysis.metrics),
  } as unknown as Record<string, unknown>);
  await put(STORES.meta, meta as unknown as Record<string, unknown>);
  return { status: "imported", record };
}

/** Persist the built-in demo activity (or return the existing copy) and hand back its id. */
export async function ensureDemoSession(id = "demo-session"): Promise<string> {
  const existing = await get<StoredSession>(STORES.sessions, id);
  if (!existing) await saveSession(demoSessionRecord(id));
  return id;
}

export { alignWind };
