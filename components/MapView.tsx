"use client";

/**
 * Track map.
 *
 * MapLibre is imported dynamically inside an effect so it never touches the server bundle and
 * never breaks SSR. The base map is OpenFreeMap's keyless *positron* style — a pale, almost
 * unlabelled surface that lets the track carry all of the colour. The track is drawn as one thin
 * solid line per segment, coloured by label: dashes were dropped deliberately, because a dashed
 * line reads as a lower-quality line rather than as "unconfirmed", and the estimate/reality
 * distinction is stated in words in the runs table instead.
 *
 * Selecting a run (from the table beside the map, from a numbered badge, or by clicking the track)
 * lifts it out of the pack: it gets a paper-white halo and a heavier line, and every other segment
 * is greyed back to a neutral, so the answer to "where did I actually go downwind" is legible at a
 * glance. Greying rather than fading is deliberate — semi-transparent segments overlap at their
 * shared endpoints and the opacity compounds into visible blobs.
 *
 * Start, finish, the wind arrow and the numbered downwind badges are HTML markers rather than symbol
 * layers: they are annotations about the session, not map geometry, and they keep working when the
 * base style changes. The numbers match the rows of the downwind table exactly, because both read
 * the same `downwindRuns` list.
 *
 * The worker must be served explicitly (see `WORKER_URL`): MapLibre v6 derives its worker path from
 * `import.meta.url`, which a bundler cannot satisfy.
 *
 * The imperative map instance is deliberately kept out of React state: every handler reads the
 * latest data from a ref, so the map is created once and never re-created when the rider edits a
 * segment.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MlMap, Marker as MlMarker, Popup as MlPopup } from "maplibre-gl";
import { effectiveLabel } from "@/lib/classify";
import { downwindRuns, LEGEND_ORDER, segmentColor, SEGMENT_LABEL_TEXT } from "@/lib/summary";
import { compassPoint, formatSpeed, formatTimeInOffset, type SpeedUnit } from "@/lib/units";
import type { EnrichedPoint, SegmentLabel, SegmentPlan } from "@/lib/types";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

const SOURCE_TRACK = "fa-track";
const SOURCE_CASING = "fa-casing";
const LAYER_HALO = "fa-halo";
const LAYER_TRACK = "fa-track-layer";

/** Paper white, so the halo reads as a gap cut around the selected run rather than as an outline. */
const HALO_COLOR = "#faf9f6";
/** What everything else turns into while one run is selected: neutral, out of the way, still legible. */
const DIMMED_COLOR = "#cdc9be";

const WIDTH_TRACK = 2.4;
const WIDTH_FOCUS = 4.8;
const WIDTH_LONGEST = 4;

/**
 * MapLibre v6 cannot infer its worker URL under a bundler (it derives a sibling path from
 * `import.meta.url`), so the worker is copied into `public/` by `scripts/copy-maplibre-worker.mjs`
 * and referenced explicitly. Without it the worker 404s, GeoJSON sources never finish loading and
 * `map.on("load")` never fires.
 */
const WORKER_URL = "/maplibre-gl-worker.mjs";

export interface MapViewProps {
  points: EnrichedPoint[];
  labels: SegmentLabel[];
  plan: SegmentPlan;
  /** the longest confirmed downwind segment, highlighted on the map */
  highlightId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** index of the point the charts are pointing at (kept in sync with the map) */
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
  unit: SpeedUnit;
  tzOffsetMin: number | null;
  wind: { dirFromDeg: number | null; speedMps: number | null; quality: string | null } | null;
}

interface TrackProps {
  id: string;
  color: string;
  /** the run the rider picked: heaviest line, halo, everything else greyed */
  selected: boolean;
  /** the longest confirmed downwind run, marked passively on load */
  highlight: boolean;
  /** either of the above — this is what gets the halo */
  focus: boolean;
  /** something else is selected, so this segment steps back */
  dim: boolean;
}

type LineFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: TrackProps;
};

function buildTrackFeatures(points: EnrichedPoint[], plan: SegmentPlan): LineFeature[] {
  const features: LineFeature[] = [];
  for (const seg of plan.segments) {
    const from = Math.max(0, seg.startIdx);
    const to = Math.min(points.length - 1, seg.endIdx);
    if (to < from) continue;
    const coordinates: [number, number][] = [];
    for (let i = from; i <= to; i++) coordinates.push([points[i].lon, points[i].lat]);
    if (coordinates.length < 2) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {
        id: seg.id,
        color: segmentColor(effectiveLabel(seg)),
        selected: false,
        highlight: false,
        focus: false,
        dim: false,
      },
    });
  }
  return features;
}

function segmentIdAt(plan: SegmentPlan, idx: number): string | null {
  for (const s of plan.segments) if (idx >= s.startIdx && idx <= s.endIdx) return s.id;
  return null;
}

/** Nearest track point to a geographic position. A plain scan is fast enough for one session. */
function nearestIndex(points: EnrichedPoint[], lng: number, lat: number): number | null {
  if (points.length === 0) return null;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dLon = (points[i].lon - lng) * 0.53; // cos(58°) ≈ 0.53, good enough for a screen-space scan
    const dLat = points[i].lat - lat;
    const d = dLon * dLon + dLat * dLat;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

function buildTooltip(
  p: EnrichedPoint,
  label: SegmentLabel,
  unit: SpeedUnit,
  tzOffsetMin: number | null,
): HTMLElement {
  const root = document.createElement("div");
  const head = document.createElement("div");
  head.textContent = label.replace(/_/g, " ");
  head.style.cssText =
    "font-weight:700;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.06em;font-size:10px";
  root.appendChild(head);

  const rows: [string, string][] = [
    ["Time", formatTimeInOffset(p.t, tzOffsetMin, true)],
    ["Speed", `${formatSpeed(p.speed, unit)} ${unit}`],
    ["Heading", p.cog == null ? "—" : `${compassPoint(p.cog)} ${Math.round(p.cog)}°`],
    ["TWA", p.twa == null ? "—" : `${Math.round(p.twa)}°`],
    ["VMG up / down", `${formatSpeed(p.vmgUpMps, unit)} / ${formatSpeed(p.vmgDownMps, unit)} ${unit}`],
    ["Wind", p.windSpeedMps == null ? "no data" : `${formatSpeed(p.windSpeedMps, unit)} ${unit}`],
  ];
  for (const [k, v] of rows) {
    const line = document.createElement("div");
    line.style.cssText = "display:flex;gap:14px;justify-content:space-between;line-height:1.55";
    const a = document.createElement("span");
    a.textContent = k;
    a.style.color = "#7b7870";
    const b = document.createElement("span");
    b.textContent = v;
    b.style.cssText = "font-variant-numeric:tabular-nums;font-weight:700";
    line.append(a, b);
    root.appendChild(line);
  }
  return root;
}

function markerElement(text: string, color: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;align-items:center;gap:4px;pointer-events:none";
  const pin = document.createElement("span");
  pin.style.cssText = `width:9px;height:9px;border-radius:999px;background:${color};border:1.5px solid #121211`;
  const label = document.createElement("span");
  label.textContent = text;
  label.style.cssText =
    "font-family:var(--font-mono);font-size:9px;font-weight:700;letter-spacing:0.06em;color:#121211;background:#faf9f6;border:1px solid #121211;border-radius:2px;padding:0 4px;text-transform:uppercase";
  el.append(pin, label);
  return el;
}

export default function MapView(props: MapViewProps) {
  const { points, labels, plan, highlightId, selectedId, onSelect, hoverIdx, onHoverIdx, unit, tzOffsetMin, wind } =
    props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markersRef = useRef<MlMarker[]>([]);
  const hoverMarkerRef = useRef<MlMarker | null>(null);
  const popupRef = useRef<MlPopup | null>(null);
  const fittedRef = useRef(false);
  /**
   * True once the map has fired `load` and its sources/layers exist. This is React state, not a
   * ref, so that effects which depend on the map being ready actually re-run when it becomes so
   * (e.g. drawing the wind arrow for a session opened before the map finished loading).
   */
  const [ready, setReady] = useState(false);
  /**
   * True while the last hover came from the map itself. The map deliberately shows no tooltip for
   * its own hover: a card that chases the cursor across the track is noise, and the same numbers
   * are one click away in the run detail. The pin and tooltip are therefore reserved for a hover
   * that came from the charts, where they answer "which point am I looking at".
   */
  const hoverFromMapRef = useRef(false);

  /** The latest data, read by the imperative map event handlers. */
  const dataRef = useRef({ points, labels, plan, onSelect, onHoverIdx, unit, tzOffsetMin });

  /* ------------------------------------------------------------------ derived */

  const features = useMemo(() => {
    return buildTrackFeatures(points, plan).map((f) => {
      const selected = selectedId != null && f.properties.id === selectedId;
      const highlight = highlightId != null && f.properties.id === highlightId;
      const focus = selected || highlight;
      // Only a deliberate selection greys out the rest; the passive "longest run" mark on load
      // should not repaint the whole map.
      const dim = selectedId != null && !focus;
      return { ...f, properties: { ...f.properties, selected, highlight, focus, dim } };
    });
  }, [points, plan, selectedId, highlightId]);

  const focusFeatures = useMemo(() => features.filter((f) => f.properties.focus), [features]);

  const runs = useMemo(() => downwindRuns(plan.segments, points), [plan, points]);

  /** Stable signature so the marker layer is rebuilt only when it actually changes. */
  const markerKey = useMemo(
    () => runs.map((r) => `${r.n}:${r.segment.id}:${r.label}`).join("|") + `#${points.length}`,
    [runs, points.length],
  );

  const legend = useMemo(() => {
    const seen = new Set<SegmentLabel>();
    for (const seg of plan.segments) seen.add(effectiveLabel(seg));
    return LEGEND_ORDER.filter((l) => seen.has(l));
  }, [plan]);

  const syncData = useCallback(
    (map: MlMap) => {
      const track = map.getSource(SOURCE_TRACK) as { setData: (d: unknown) => void } | undefined;
      const casing = map.getSource(SOURCE_CASING) as { setData: (d: unknown) => void } | undefined;
      track?.setData({ type: "FeatureCollection", features });
      casing?.setData({ type: "FeatureCollection", features: focusFeatures });
    },
    [features, focusFeatures],
  );

  const fitToTrack = useCallback((map: MlMap) => {
    const pts = dataRef.current.points;
    if (pts.length < 2) return;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const p of pts) {
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    }
    const pad = Math.max((maxLon - minLon) * 0.12, (maxLat - minLat) * 0.12, 0.002);
    map.fitBounds(
      [
        [minLon - pad, minLat - pad],
        [maxLon + pad, maxLat + pad],
      ],
      { duration: 0, padding: 24 },
    );
  }, []);

  /** Late-bound references so the create-once effect can call the newest versions. */
  const syncDataRef = useRef(syncData);
  const fitToTrackRef = useRef(fitToTrack);

  /* ------------------------------------------------------------------- effects */

  // Keep the imperative handlers reading current data.
  useEffect(() => {
    dataRef.current = { points, labels, plan, onSelect, onHoverIdx, unit, tzOffsetMin };
  }, [points, labels, plan, onSelect, onHoverIdx, unit, tzOffsetMin]);

  useEffect(() => {
    syncDataRef.current = syncData;
  }, [syncData]);

  useEffect(() => {
    fitToTrackRef.current = fitToTrack;
  }, [fitToTrack]);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      const maplibregl = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;

      maplibregl.setWorkerUrl(WORKER_URL);

      const map = new maplibregl.Map({
        container,
        // The style carries its own OpenFreeMap / OpenMapTiles / OpenStreetMap attribution.
        style: BASEMAP_STYLE,
        center: [5.5, 58.7],
        zoom: 10,
        attributionControl: { compact: true },
      });
      mapRef.current = map;

      map.on("load", () => {
        if (cancelled) return;
        map.addSource(SOURCE_TRACK, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addSource(SOURCE_CASING, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        // Two layers, bottom first. The halo is paper-white and only exists for the focused run, so
        // it reads as a clean gap cut around it; the track on top is one thin solid line per
        // segment, coloured by label. Everything not focused greys back while a run is selected.
        map.addLayer({
          id: LAYER_HALO,
          type: "line",
          source: SOURCE_CASING,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": HALO_COLOR,
            "line-width": ["case", ["get", "selected"], 10.5, 9],
            "line-opacity": 1,
          },
        });
        map.addLayer({
          id: LAYER_TRACK,
          type: "line",
          source: SOURCE_TRACK,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["case", ["get", "dim"], DIMMED_COLOR, ["get", "color"]],
            "line-width": [
              "case",
              ["get", "selected"],
              WIDTH_FOCUS,
              ["get", "highlight"],
              WIDTH_LONGEST,
              ["get", "dim"],
              2,
              WIDTH_TRACK,
            ],
            "line-opacity": 1,
          },
        });

        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

        syncDataRef.current(map);
        fitToTrackRef.current(map);
        setReady(true);
      });

      // ---------------------------------------------------------- interaction
      let raf = 0;
      let pending: { x: number; y: number } | null = null;
      const flushHover = () => {
        raf = 0;
        if (!pending) return;
        const { x, y } = pending;
        pending = null;
        const ll = map.unproject([x, y]);
        hoverFromMapRef.current = true;
        dataRef.current.onHoverIdx(nearestIndex(dataRef.current.points, ll.lng, ll.lat));
      };

      map.on("mousemove", (e) => {
        pending = { x: e.point.x, y: e.point.y };
        if (!raf) raf = requestAnimationFrame(flushHover);
        map.getCanvas().style.cursor = "crosshair";
      });
      map.on("mouseout", () => {
        hoverFromMapRef.current = false;
        dataRef.current.onHoverIdx(null);
      });
      map.on("click", (e) => {
        const idx = nearestIndex(dataRef.current.points, e.lngLat.lng, e.lngLat.lat);
        if (idx == null) {
          dataRef.current.onSelect(null);
          return;
        }
        dataRef.current.onSelect(segmentIdAt(dataRef.current.plan, idx));
      });
    })();

    return () => {
      cancelled = true;
      setReady(false);
      fittedRef.current = false;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Push the current track into the map's GeoJSON sources.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    syncData(map);
  }, [ready, syncData]);

  // Fit the view the first time a real track arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || fittedRef.current || points.length < 2) return;
    fittedRef.current = true;
    fitToTrack(map);
  }, [ready, points, fitToTrack]);

  // Start / finish / wind arrow / numbered downwind badges.
  useEffect(() => {
    let cancelled = false;
    const map = mapRef.current;
    if (!map || !ready || points.length === 0) return;

    (async () => {
      const maplibregl = await import("maplibre-gl");
      if (cancelled || !mapRef.current) return;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      const start = points[0];
      const end = points[points.length - 1];
      markersRef.current.push(
        new maplibregl.Marker({ element: markerElement("Start", "#14a45c"), anchor: "left" })
          .setLngLat([start.lon, start.lat])
          .addTo(map),
        new maplibregl.Marker({ element: markerElement("Finish", "#e0763a"), anchor: "left" })
          .setLngLat([end.lon, end.lat])
          .addTo(map),
      );

      // Numbered downwind candidates. The number is the same one the table shows.
      for (const run of runs) {
        const mid = Math.floor((run.segment.startIdx + run.segment.endIdx) / 2);
        const at = points[mid];
        if (!at) continue;
        const el = document.createElement("button");
        el.type = "button";
        el.className = "dw-marker";
        el.textContent = String(run.n);
        el.dataset.kind = run.segment.manualLabel == null ? "estimate" : run.label;
        el.dataset.segmentId = run.segment.id;
        const f = run.segment.features;
        el.title = `Run ${run.n} · ${SEGMENT_LABEL_TEXT[run.label]} · ${(f.distanceM / 1000).toFixed(2)} km · ${Math.round(f.durationS)} s`;
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          dataRef.current.onSelect(run.segment.id);
        });
        markersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([at.lon, at.lat]).addTo(map),
        );
      }

      if (wind?.dirFromDeg != null) {
        const center = points[Math.floor(points.length / 2)];
        const dir = wind.dirFromDeg;
        const el = document.createElement("div");
        el.className = "wind-arrow";
        el.title = `Wind from ${Math.round(dir)}° (${compassPoint(dir)}) — the arrow points at the source of the wind`;
        // The arrow tip points at the wind source so the graphic agrees with the "FROM" direction
        // the rest of the app reports (and with positive upwind VMG pointing the same way).
        el.innerHTML = `
          <div class="wind-arrow-glyph">
            <svg width="30" height="30" viewBox="0 0 34 34" style="transform: rotate(${dir}deg)">
              <path d="M17 3 L24 26 L17 21 L10 26 Z" fill="#0f7c7c" stroke="#faf9f6" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="wind-arrow-label">${compassPoint(dir)} ${Math.round(dir)}°</div>`;
        markersRef.current.push(
          new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat([center.lon, center.lat])
            .addTo(map),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [markerKey, points, runs, wind?.dirFromDeg, ready]);

  // Mark the badge of the selected run, so the map and the table agree about which row is active.
  // This only touches `data-selected` on markers that already exist; rebuilding them here would
  // make every badge flicker on each click.
  useEffect(() => {
    for (const m of markersRef.current) {
      const el = m.getElement();
      if (!el.classList.contains("dw-marker")) continue;
      el.dataset.selected = el.dataset.segmentId === selectedId ? "true" : "false";
    }
  }, [selectedId, ready, markerKey]);

  // Hover pin + tooltip, driven by whichever chart or map set the cursor.
  useEffect(() => {
    let cancelled = false;
    const map = mapRef.current;
    if (!map || !ready) return;

    (async () => {
      const maplibregl = await import("maplibre-gl");
      if (cancelled || !mapRef.current) return;

      if (hoverIdx == null || !points[hoverIdx] || hoverFromMapRef.current) {
        hoverMarkerRef.current?.remove();
        hoverMarkerRef.current = null;
        popupRef.current?.remove();
        popupRef.current = null;
        return;
      }

      const p = points[hoverIdx];
      const label = labels[hoverIdx] ?? "unclassified";
      if (!hoverMarkerRef.current) {
        const el = document.createElement("div");
        el.className = "hover-pin";
        hoverMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" });
      }
      hoverMarkerRef.current.setLngLat([p.lon, p.lat]).addTo(map);

      if (!popupRef.current) {
        popupRef.current = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 14,
          maxWidth: "260px",
        });
      }
      popupRef.current
        .setDOMContent(buildTooltip(p, label, unit, tzOffsetMin))
        .setLngLat([p.lon, p.lat])
        .addTo(map);
    })();

    return () => {
      cancelled = true;
    };
  }, [hoverIdx, points, labels, unit, tzOffsetMin, ready]);

  // Zoom to the selected segment.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || selectedId == null) return;
    const seg = plan.segments.find((s) => s.id === selectedId);
    if (!seg) return;
    const from = Math.max(0, seg.startIdx);
    const to = Math.min(points.length - 1, seg.endIdx);
    if (to <= from) return;
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (let i = from; i <= to; i++) {
      const p = points[i];
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    }
    const padLon = Math.max((maxLon - minLon) * 0.25, 0.0015);
    const padLat = Math.max((maxLat - minLat) * 0.25, 0.0015);
    map.fitBounds(
      [
        [minLon - padLon, minLat - padLat],
        [maxLon + padLon, maxLat + padLat],
      ],
      { duration: 500, padding: 40 },
    );
  }, [selectedId, plan, points, ready]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[52vh] min-h-[320px] w-full overflow-hidden border border-ink sm:h-[62vh]"
      />
      <div className="pointer-events-none absolute left-3 top-3 map-chip">
        click a run to zoom in
        <span className="hidden sm:inline"> · or click the track to pick a block</span>
      </div>
      <div className="north-arrow absolute right-3 top-[104px]" title="North is up">
        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
          <path d="M5 0 L10 12 L5 8.6 L0 12 Z" fill="#121211" />
        </svg>
        <span>N</span>
      </div>
      {legend.length > 0 && (
        <div className="absolute bottom-16 left-3 map-legend max-w-[52%] sm:bottom-3">
          {legend.map((label) => (
            <div key={label} className="map-legend-row">
              <span className="map-legend-line" style={{ borderTopColor: segmentColor(label) }} />
              <span>{SEGMENT_LABEL_TEXT[label]}</span>
            </div>
          ))}
          <div className="map-legend-row mt-1 border-t border-quiet pt-1">
            <span className="map-legend-badge" />
            <span>numbered = downwind run</span>
          </div>
        </div>
      )}
      {points.length === 0 && (
        <div className="absolute inset-0 grid place-items-center bg-card/80 text-sm text-grey">
          No track points
        </div>
      )}
    </div>
  );
}
