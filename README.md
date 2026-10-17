# Parawing stats

Personal foiling analytics for parawing / wingfoil / downwind sessions recorded on a Garmin watch
(or anything that exports `.fit` / `.gpx`). Import a file, get the track on a map, the wind you
rode in, upwind and downwind VMG, every downwind surf run, and the numbers behind them.

Local-first: parsing, cleaning, metrics and storage all happen in your browser. The only server-side
code is a thin weather proxy that keeps API credentials out of the client bundle.

---

## What it does

- **Import** `.fit` and `.gpx` files in the browser. Duplicate timestamps, GPS spikes, timer pauses,
  gaps and missing fixes are detected and reported — never silently invented or interpolated over.
- **Track map** with the whole session coloured per segment: upwind, powered downwind, confirmed
  free (packed-wing) downwind, unclassified. Start/finish markers, a numbered badge on every
  downwind run, a wind arrow, a legend, a north arrow and a scale bar, hover/tap readouts
  (time, speed, heading, TWA, VMG), and the longest downwind run highlighted.
- **Wind** fetched automatically from **MET Norway Frost** (measured station observations) when a
  key is configured, with **Open-Meteo** (modelled reanalysis, clearly labelled) and **manual
  entry** as alternatives. Nearest first, station search and override, and a plain statement of
  which station was used and how far away it was.
- **Metrics** time-weighted over the real timestamps (never assuming a fixed sample interval):
  distance, moving time, average/max speed, upwind and downwind time and distance, VMG distributions.
- **Downwind runs** auto-suggested as a complete tiling of the track, then editable by hand —
  split, merge, mark free / powered / excluded. Corrections persist and the stats recompute instantly.
  The confirmed and suggested runs are also listed as a table (start, distance, duration, speed in
  your unit **and** in m/s, VMG), row-clickable to open that run on the map.
- **Best efforts**: the fastest one, two and three minute windows of the session and the best upwind
  and downwind VMG in each, with the session average marked on every bar so a "best" has something
  to be best against.
- **Equipment profiles** for the wing, foil and stabiliser, so sessions can be compared later.
- **Demo activity**: a deterministic, clearly-labelled synthetic session so you can explore the app
  before you have a file to hand.

All times are stored as UTC epoch milliseconds; the original timezone offset is kept per session and
used for display. Wind angles are handled circularly (unit vectors) — angles are never averaged
arithmetically. Anything derived from wind is labelled as an estimate.

## Quick start

Requires **Node.js 22+**.

```bash
npm install
cp .env.example .env.local     # optional: add a Frost key (see below)
npm run dev                    # http://localhost:3000
```

Click **Load demo activity** to explore, or drag a `.fit` / `.gpx` file onto the landing page.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server (runs `predev` first — see *MapLibre worker* below) |
| `npm run build` | Production build (`prebuild` copies the worker) |
| `npm start` | Serve the production build (`prestart` copies the worker) |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

> **MapLibre worker.** MapLibre GL v6 guesses its worker URL from `import.meta.url`, which cannot
> resolve inside a bundle: the worker 404s, GeoJSON sources never finish loading, and
> `map.on("load")` never fires (no track, no markers). `scripts/copy-maplibre-worker.mjs` copies the
> worker into `public/` and the map points at it explicitly. It runs via `predev` / `prebuild` /
> `prestart`; if you invoke `next dev` or `next build` directly, run the script yourself first.

## Weather providers and credentials

Credentials live only on the server (route handlers under `app/api/weather/`) and are read from
environment variables. Copy `.env.example` to `.env.local`:

| Variable | Provider | Notes |
| --- | --- | --- |
| `FROST_CLIENT_ID` | MET Norway Frost | Free. Register at <https://frost.met.no/auth/requestCredentials.html>. Returns **measured** station observations. |
| `FROST_BASE_URL` | MET Norway Frost | Optional; defaults to `https://frost.met.no`. |
| `HOLFUY_API_KEY` | Holfuy | Optional. The provider is not implemented yet and reports itself as unsupported. |

**Open-Meteo** needs no key. It is reanalysis/model output, so it is labelled `modelled` everywhere
it appears and is only used when you explicitly pick it — the app never quietly substitutes modelled
wind for a measurement.

If Frost has no data near the track (common offshore), the app says so and falls back to manual
entry rather than guessing. You can also always type the wind you actually rode in.

## How the numbers are defined

- **TWA** = `|Δ(course over ground, wind FROM direction)|`; 0° is head to wind, 180° is a dead run.
- **Upwind VMG** = `SOG · cos(TWA)` — positive toward the wind source.
- **Downwind VMG** = `SOG · cos(180° − TWA)` — positive away from the wind source.
- Averages are **time-weighted** (trapezoid over actual timestamps), so a 1 Hz file and a 2 Hz file
  of the same session agree. Intervals are attributed to the segment containing their end point so
  segment totals add up exactly to the session totals.
- Wind direction interpolation happens on unit vectors and is only carried across gaps up to
  `maxGapS` (default 5400 s); beyond that the wind is `null` rather than stretched.

Only segments you confirm as downwind count in the downwind statistics — the classifier's
suggestions are drawn dashed on the map but never presented as fact.

## Basemap

The map uses [OpenFreeMap](https://openfreemap.org)'s keyless **positron** style — a pale, almost
unlabelled surface (OpenStreetMap data vectorised by OpenMapTiles) so the track carries all of the
colour on the paper background. No API key, no account, and no per-view billing; the style ships its
own attribution, which MapLibre shows in the corner. If you would rather run your own tiles, change
the single `BASEMAP_STYLE` constant in `components/MapView.tsx`.

## Design

The visual language is a printed specimen sheet: a warm paper surface with a faint drafting grid,
hairline rules, registration crop marks at the panel corners, a numbered bracket tag on every panel
(`01 / WIND`, `02 / TRACK`, …) and mostly monospaced labels.

Two self-hosted, SIL-OFL licensed families do the work, loaded from `@fontsource` so there is no
third-party request at runtime:

- **Open Sauce Two** for headings and the large stat values,
- **Space Mono** for labels, units, chips, table figures and map chrome.

Colour is semantic, not decorative. Signal green is ordinary sailing (upwind), Soft Origin is
downwind with the parawing still flying, Familiar Tone is the free / packed-wing run, and everything
the app is unsure about is a neutral grey. All of it is defined once as tokens in `app/globals.css`,
so a colour change is a one-line change. The accent hexes are repeated in `lib/summary.ts` as
`SEGMENT_COLORS` because map lines need darker values than a pale basemap allows.

## Project layout

```
app/
  page.tsx                     sessions overview + import
  sessions/[id]/page.tsx       one session (params read inside <Suspense>)
  api/weather/{providers,stations,observations}/route.ts
components/                    dashboard, map, charts, runs table, best windows, timeline,
                               wind + equipment panels, shared ui primitives
lib/
  geo.ts units.ts              haversine/bearing/circular maths, unit conversion
  import/{fit,gpx,index}.ts    file → RawSample[] + metadata
  clean.ts                     dedupe, spike/outlier rejection, pauses, gaps, distance
  metrics.ts                   time-weighted statistics and distributions
  bestWindows.ts               best 1/2/3-minute speed and VMG windows
  wind/                        provider interface, alignment, server providers, client
  classify.ts                  downwind detection + split/merge/relabel editing
  summary.ts                   shared labels, colours and wind-source wording
  storage/                     IndexedDB store (localStorage fallback) + hash dedupe
  demo.ts                      deterministic synthetic session
tests/                         10 suites, 162 tests
```

Each `lib/` module is pure and independently tested: the same code runs in the browser (so edits
recompute instantly) and in Vitest.

## Storage and privacy

Sessions are stored in your browser in IndexedDB (`sessions` holds the immutable track, `meta` holds
your edits, `settings` holds equipment presets), with a localStorage fallback. Files are deduplicated
by the SHA-256 hash of their contents, so re-importing the same file does not create a second copy.
Nothing is uploaded — the only outbound requests are the weather lookups you trigger, which go
through this app's own proxy.

## Deploying to Netlify

1. Push the repository to GitHub/GitLab and create a Netlify site from it.
2. Build settings come from `netlify.toml` (`npm run build`, publish `.next`, Node 22). Netlify
   detects Next.js and installs the Next.js Runtime automatically.
3. Add the weather credentials under **Site configuration → Environment variables**
   (`FROST_CLIENT_ID`, optionally `FROST_BASE_URL`). Without a Frost key the app still works — you
   get Open-Meteo and manual wind entry.
4. Deploy. `npm run build` also runs `prebuild`, so the MapLibre worker is present in `public/`.

Nothing else is required: there is no database, no queue, and no long-running process.

## Deliberate limits (V1)

- No accounts, OAuth, subscriptions or payments. No Strava/Garmin sync yet — the import layer is
  shaped for it (`lib/import/`), but files are imported by hand.
- Single-user and local to one browser; the data model is cloud-sync-ready but nothing syncs.
- Session comparison and equipment comparison across sessions are not built yet.
- Holfuy is a stub. The downwind classifier is rule-based (`dw-classifier-v1`, confidence capped at
  80%); user corrections are stored so it can be replaced by a learned model later.
