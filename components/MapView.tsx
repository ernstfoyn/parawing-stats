"use client";

/**
 * Track map.
 *
 * MapLibre is imported dynamically inside an effect so it never touches the server bundle and
 * never breaks SSR. The base map is OpenFreeMap's keyless dark style and the track is drawn as one
 * GeoJSON line per segment, coloured by its label. Automatic (not yet confirmed) downwind segments
 * are dashed so the rider can always tell an estimate from a decision they made.
 *
 * Start, finish and the wind arrow are HTML markers rather than symbol layers: they are annotations
 * about the session, not map geometry, and they keep working when the base style changes.
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
import { segmentColor } from "@/lib/summary";
import { compassPoint, formatSpeed, formatTimeInOffset, type SpeedUnit } from "@/lib/units";
import type { EnrichedPoint, SegmentLabel, SegmentPlan } from "@/lib/types";

const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

const SOURCE_TRACK = "fa-track";
const SOURCE_HIGHLIGHT = "fa-highlight";
const LAYER_HALO = "fa-halo";
const LAYER_DASHED = "fa-dashed";
const LAYER_SOLID = "fa-solid";
const LAYER_SELECTED = "fa-selected";

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
  dashed: boolean;
  selected: boolean;
  highlight: boolean;
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
        dashed: seg.manualLabel == null,
        selected: false,
        highlight: false,
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
  head.style.cssText = "font-weight:600;margin-bottom:4px;text-transform:capitalize";
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
    line.style.cssText = "display:flex;gap:10px;justify-content:space-between;line-height:1.5";
    const a = document.createElement("span");
    a.textContent = k;
    a.style.color = "#7d90a8";
    const b = document.createElement("span");
    b.textContent = v;
    b.style.cssText = "font-variant-numeric:tabular-nums";
    line.append(a, b);
    root.appendChild(line);
  }
  return root;
}

function markerElement(text: string, color: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;align-items:center;gap:4px;pointer-events:none";
  const pin = document.createElement("span");
  pin.style.cssText = `width:10px;height:10px;border-radius:999px;background:${color};border:2px solid #061019;box-shadow:0 0 0 2px ${color}55`;
  const label = document.createElement("span");
  label.textContent = text;
  label.style.cssText =
    "font-size:10px;font-weight:600;letter-spacing:0.04em;color:#e9f1fa;background:#0b131fcc;border:1px solid #22324a;border-radius:999px;padding:1px 6px;text-transform:uppercase";
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

  /** The latest data, read by the imperative map event handlers. */
  const dataRef = useRef({ points, labels, plan, onSelect, onHoverIdx, unit, tzOffsetMin });

  /* ------------------------------------------------------------------ derived */

  const features = useMemo(() => {
    return buildTrackFeatures(points, plan).map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        selected: selectedId != null && f.properties.id === selectedId,
        highlight: highlightId != null && f.properties.id === highlightId,
      },
    }));
  }, [points, plan, selectedId, highlightId]);

  const highlightFeatures = useMemo(
    () => features.filter((f) => f.properties.highlight),
    [features],
  );

  const syncData = useCallback(
    (map: MlMap) => {
      const track = map.getSource(SOURCE_TRACK) as { setData: (d: unknown) => void } | undefined;
      const halo = map.getSource(SOURCE_HIGHLIGHT) as { setData: (d: unknown) => void } | undefined;
      track?.setData({ type: "FeatureCollection", features });
      halo?.setData({ type: "FeatureCollection", features: highlightFeatures });
    },
    [features, highlightFeatures],
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
  /** Marker rebuild is debounced to the point count so a relabel never re-creates markers. */
  const markerKey = points.length;

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
        map.addSource(SOURCE_HIGHLIGHT, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addLayer({
          id: LAYER_HALO,
          type: "line",
          source: SOURCE_HIGHLIGHT,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#e9f1fa", "line-width": 10, "line-opacity": 0.28 },
        });
        map.addLayer({
          id: LAYER_DASHED,
          type: "line",
          source: SOURCE_TRACK,
          filter: ["==", ["get", "dashed"], true],
          layout: { "line-cap": "butt", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["case", ["get", "highlight"], 5.5, 3.2],
            "line-dasharray": [2, 2],
            "line-opacity": 0.95,
          },
        });
        map.addLayer({
          id: LAYER_SOLID,
          type: "line",
          source: SOURCE_TRACK,
          filter: ["==", ["get", "dashed"], false],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["get", "color"],
            "line-width": ["case", ["get", "highlight"], 6, 3.4],
          },
        });
        map.addLayer({
          id: LAYER_SELECTED,
          type: "line",
          source: SOURCE_TRACK,
          filter: ["==", ["get", "selected"], true],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.55 },
        });

        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

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
        dataRef.current.onHoverIdx(nearestIndex(dataRef.current.points, ll.lng, ll.lat));
      };

      map.on("mousemove", (e) => {
        pending = { x: e.point.x, y: e.point.y };
        if (!raf) raf = requestAnimationFrame(flushHover);
        map.getCanvas().style.cursor = "crosshair";
      });
      map.on("mouseout", () => {
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

  // Start / finish / wind-arrow markers.
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
        new maplibregl.Marker({ element: markerElement("Start", "#2dd4bf"), anchor: "left" })
          .setLngLat([start.lon, start.lat])
          .addTo(map),
        new maplibregl.Marker({ element: markerElement("Finish", "#f97316"), anchor: "left" })
          .setLngLat([end.lon, end.lat])
          .addTo(map),
      );

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
              <path d="M17 3 L24 26 L17 21 L10 26 Z" fill="#38bdf8" stroke="#061019" stroke-width="1.2" stroke-linejoin="round"/>
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
  }, [markerKey, points, wind?.dirFromDeg, ready]);

  // Hover pin + tooltip, driven by whichever chart or map set the cursor.
  useEffect(() => {
    let cancelled = false;
    const map = mapRef.current;
    if (!map || !ready) return;

    (async () => {
      const maplibregl = await import("maplibre-gl");
      if (cancelled || !mapRef.current) return;

      if (hoverIdx == null || !points[hoverIdx]) {
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
        className="h-[52vh] min-h-[320px] w-full overflow-hidden rounded-xl border border-line-soft sm:h-[62vh]"
      />
      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-line-soft bg-ink/85 px-2 py-1 text-[0.62rem] text-fog backdrop-blur">
        Tap the track to select a segment · hover for time, speed and VMG
      </div>
      {points.length === 0 && (
        <div className="absolute inset-0 grid place-items-center rounded-xl bg-ink/70 text-sm text-fog">
          No track points
        </div>
      )}
    </div>
  );
}
