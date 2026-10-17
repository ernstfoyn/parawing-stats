# Foil Analyzer — implementation plan

## Architecture decision: TypeScript-only, local-first

The brief allows a Python backend "if appropriate". It is **not** appropriate here:

- FIT parsing: `@garmin/fitsdk` (official Garmin JS SDK, browser + Node) — reliable, maintained.
- GPX parsing: `fast-xml-parser` — namespace-aware, browser + Node.
- Everything (parse → clean → metrics → segments) is pure TypeScript, so the *same* code runs
  in the browser (instant re-analysis when the user re-labels a segment) and in Vitest (tests).
- A Python service would add a second runtime, a second deployment target and a network hop for
  every recalculation, with zero added correctness.

The only server-side code is a thin weather proxy (route handlers) that keeps API credentials
out of the browser bundle. Netlify's Next.js runtime hosts that for free.

Stack: **Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · MapLibre GL JS ·
Recharts · IndexedDB (persistence) · Vitest (tests)**.

## Layers (each layer is a pure module with tests)

| Module | Responsibility |
| --- | --- |
| `lib/geo.ts` | haversine distance, initial bearing, angle normalize/delta, circular mean & angle interpolation |
| `lib/units.ts` | m/s ↔ knots ↔ km/h, metres ↔ km/nm, formatting |
| `lib/import/gpx.ts`, `lib/import/fit.ts` | raw file → `RawSample[]` + `RawActivityMeta` (never invents data) |
| `lib/clean.ts` | dedupe timestamps, reject invalid fixes, speed-spike/outlier rejection, cumulative distance, pauses, gaps |
| `lib/metrics.ts` | time-weighted stats (uneven sampling), moving time, avg/max speed, direction stats, distributions |
| `lib/wind/` | `WeatherProvider` interface + Frost, Open-Meteo, Holfuy (stub), manual; circular interpolation onto the track |
| `lib/classify.ts` | downwind candidate detection + powered/free estimate + manual segment editing (split/merge/label) |
| `lib/demo.ts` | deterministic synthetic session (clearly labelled) |
| `lib/storage/` | IndexedDB session store, content-hash dedupe, migration-friendly records |

## Data flow

```
file ──parse──> RawSample[] ──clean──> TrackPoint[] ──+wind samples──> EnrichedPoint[]
                                            │
                                            ├──classify──> SegmentPlan (full tiling of the track)
                                            └──metrics───> SessionMetrics
                                            SegmentPlan ──manual edits──> recompute stats (no re-parse)
```

The **segment plan is the source of truth** for downwind statistics. Auto-detection produces a
complete tiling (every point belongs to exactly one segment) so split / merge / relabel are
simple, lossless operations. `manualLabel` overrides `auto.label`; auto features + confidence +
reasons are kept so the classifier can be trained on user corrections later.

## Metric conventions (documented in-app)

- Positive **upwind VMG** = speed toward the wind source: `vmg = SOG · cos(TWA)`.
- Positive **downwind VMG** = speed away from the wind source: `vmg = SOG · cos(180° − TWA)`.
- `TWA = |Δ(course over ground, wind FROM direction)|`, 0° = head to wind, 180° = dead run.
- All averages are **time-weighted** (trapezoid over actual timestamps), never sample-count based.
- Wind direction is circular: averaging, differencing and interpolation all happen on unit vectors.
- Anything derived from wind is labelled **estimated**; modelled/remote data is never presented as
  measured on-course conditions.

## Phases

1. Scaffold + config (done), Tailwind theme tokens, paper-specimen design system.
2. Core math (geo, units, clean, metrics) + Vitest tests + synthetic tracks.
3. Importers (GPX, FIT) + hash dedupe + tests (FIT round-trip via the SDK encoder).
4. Wind: provider interface, Frost proxy route, Open-Meteo fallback, manual entry, circular alignment.
5. Classifier + tests (boundaries, wrapping, hysteresis, manual editing).
6. UI: sessions overview + import, dashboard (wind, map, metrics, DW stats, charts, timeline, equipment).
7. Map: MapLibre, categorised track layers, wind arrow, start/finish, hover tooltip, chart sync.
8. Persistence: IndexedDB, corrections stored, equipment presets, demo activity.
9. Verify: `vitest run`, `next build`, manual end-to-end (import demo → wind → edit segments → reload).
10. Docs: README (setup, Frost key, Netlify deploy), `.env.example`, `netlify.toml`.
11. Redesign: paper-specimen identity (Open Sauce Two + Space Mono, hairline plates, crop marks),
    light positron basemap, numbered downwind badges + map legend, downwind runs table, and
    best-effort 1/2/3-minute speed and VMG windows (`lib/bestWindows.ts`).
