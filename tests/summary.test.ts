import { describe, expect, it } from "vitest";
import {
  LEGEND_ORDER,
  SEGMENT_COLORS,
  SEGMENT_LABEL_TEXT,
  describeWindSource,
  isEstimated,
  segmentColor,
  segmentTitle,
} from "@/lib/summary";
import type { Segment, StationRef, WindModel } from "@/lib/types";

function wind(over: Partial<WindModel>): WindModel {
  return { kind: "none", station: null, manual: null, maxGapS: 5400, interpolate: true, ...over };
}

const station: StationRef = {
  providerId: "frost",
  id: "SN50540",
  name: "Sola",
  lat: 58.88,
  lon: 5.63,
  elevationM: 7,
  distanceKm: 9.4,
  elements: ["wind_speed"],
  reasons: [],
  score: 0.8,
  hasWind: true,
};

describe("describeWindSource", () => {
  it("says so when there is no wind", () => {
    expect(describeWindSource(wind({}))).toBe("No wind");
  });

  it("describes manual wind without pretending it was measured", () => {
    const label = describeWindSource(
      wind({ kind: "manual", manual: { speedMps: 9, dirFromDeg: 300, gustMps: 12 } }),
    );
    expect(label).toBe("Manual wind");
    expect(label).not.toMatch(/measured/i);
  });

  it("names the provider and the station", () => {
    expect(describeWindSource(wind({ kind: "frost", station }))).toBe("MET Norway Frost · Sola");
  });

  it("falls back to the provider name when no station was chosen", () => {
    expect(describeWindSource(wind({ kind: "open-meteo" }))).toMatch(/Open-Meteo/);
  });
});

describe("segment presentation", () => {
  it("has a distinct colour for each of the four headline categories", () => {
    const headline = ["upwind", "powered_downwind", "free_downwind", "unclassified"] as const;
    const colours = headline.map((l) => segmentColor(l));
    expect(new Set(colours).size).toBe(headline.length);
  });

  it("gives every label a colour and a human name", () => {
    for (const key of Object.keys(SEGMENT_COLORS)) {
      expect(SEGMENT_COLORS[key as keyof typeof SEGMENT_COLORS]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(SEGMENT_LABEL_TEXT[key as keyof typeof SEGMENT_LABEL_TEXT]).toBeTruthy();
    }
  });

  it("lists downwind first in the legend", () => {
    expect(LEGEND_ORDER[0]).toBe("free_downwind");
    expect(LEGEND_ORDER[1]).toBe("powered_downwind");
  });

  it("treats only classifier labels as estimates", () => {
    const seg = { manualLabel: null } as Segment;
    expect(isEstimated(seg)).toBe(true);
    expect(isEstimated({ manualLabel: "free_downwind" } as Segment)).toBe(false);
  });

  it("summarises a segment with its label and distance", () => {
    const seg = {
      id: "s",
      startIdx: 0,
      endIdx: 9,
      auto: { label: "free_downwind", confidence: 0.6, reasons: [] },
      manualLabel: null,
      features: { distanceM: 1234, durationS: 300 },
    } as unknown as Segment;
    const title = segmentTitle(seg, (m) => `${(m / 1000).toFixed(1)} km`);
    expect(title).toBe("Free downwind · 1.2 km");
  });
});
