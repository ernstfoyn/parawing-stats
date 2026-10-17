import { describe, expect, it } from "vitest";
import {
  angleDelta,
  angleDiffAbs,
  bearingDeg,
  circularConcentration,
  circularMeanDeg,
  centroid,
  destination,
  haversineM,
  isPlausiblePosition,
  lerpAngle,
  median,
  normalize180,
  normalize360,
  percentile,
} from "@/lib/geo";

const LAT_M = 111_194.93; // metres per degree of latitude on the mean sphere

describe("haversineM", () => {
  it("is zero for identical points", () => {
    expect(haversineM({ lat: 58.7, lon: 5.5 }, { lat: 58.7, lon: 5.5 })).toBe(0);
  });

  it("measures a degree of latitude", () => {
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(LAT_M, 0);
  });

  it("is symmetric", () => {
    const a = { lat: 58.71, lon: 5.5 };
    const b = { lat: 58.74, lon: 5.53 };
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 9);
  });

  it("shrinks longitude distance with latitude", () => {
    const atEquator = haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    const at60 = haversineM({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
    expect(at60 / atEquator).toBeCloseTo(0.5, 2);
  });

  it("is accurate for the short hops between GPS samples", () => {
    // 10 m due north of a known point.
    const a = { lat: 58.7, lon: 5.5 };
    const b = destination(a, 0, 10);
    expect(haversineM(a, b)).toBeCloseTo(10, 2);
  });
});

describe("bearingDeg", () => {
  it("points north, east and south as expected", () => {
    expect(bearingDeg({ lat: 58, lon: 5 }, { lat: 59, lon: 5 })).toBeCloseTo(0, 6);
    // A great circle between two points on the same parallel starts very slightly poleward of
    // due east, which is why this is 89.58° and not exactly 90°.
    expect(bearingDeg({ lat: 58, lon: 5 }, { lat: 58, lon: 6 })).toBeCloseTo(89.58, 1);
    expect(bearingDeg({ lat: 59, lon: 5 }, { lat: 58, lon: 5 })).toBeCloseTo(180, 6);
  });

  it("returns null for coincident points", () => {
    expect(bearingDeg({ lat: 58, lon: 5 }, { lat: 58, lon: 5 })).toBeNull();
  });

  it("round-trips with destination()", () => {
    for (const heading of [0, 37, 179, 181, 270, 359]) {
      const from = { lat: 58.7, lon: 5.5 };
      const to = destination(from, heading, 250);
      expect(bearingDeg(from, to)).not.toBeNull();
      expect(angleDiffAbs(bearingDeg(from, to)!, heading)).toBeLessThan(0.2);
    }
  });

  it("crosses the antimeridian without flipping", () => {
    const b = bearingDeg({ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 });
    expect(angleDiffAbs(b!, 90)).toBeLessThan(0.5);
  });
});

describe("angle helpers", () => {
  it("normalises into [0, 360)", () => {
    expect(normalize360(-10)).toBeCloseTo(350, 9);
    expect(normalize360(370)).toBeCloseTo(10, 9);
    expect(normalize360(360)).toBeCloseTo(0, 9);
  });

  it("normalises into [-180, 180)", () => {
    expect(normalize180(190)).toBeCloseTo(-170, 9);
    expect(normalize180(-190)).toBeCloseTo(170, 9);
    expect(normalize180(180)).toBeCloseTo(180, 9);
  });

  it("takes the short way around the 0/360 wrap", () => {
    expect(normalize180(-180)).toBe(180);
    expect(angleDelta(350, 10)).toBeCloseTo(-20, 9);
    expect(angleDelta(10, 350)).toBeCloseTo(20, 9);
    expect(angleDiffAbs(350, 10)).toBeCloseTo(20, 9);
    expect(angleDiffAbs(1, 359)).toBeCloseTo(2, 9);
    // The classic bug: |350 - 10| = 340, which is wrong.
    expect(angleDiffAbs(350, 10)).not.toBeCloseTo(340, 0);
  });

  it("interpolates along the shortest arc", () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 6);
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 6);
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 6);
    expect(lerpAngle(170, -170, 0.5)).toBeCloseTo(180, 6);
  });

  it("averages circularly, not arithmetically", () => {
    expect(circularMeanDeg([350, 10])!).toBeCloseTo(0, 6);
    expect(circularMeanDeg([0, 90, 180, 270])).toBeNull(); // perfectly balanced
    expect(circularMeanDeg([90, 90, 90])!).toBeCloseTo(90, 6);
    const arithmeticWouldBeWrong = (350 + 10) / 2;
    expect(circularMeanDeg([350, 10])!).not.toBeCloseTo(arithmeticWouldBeWrong, 0);
  });

  it("reports concentration", () => {
    expect(circularConcentration([42, 42, 42])).toBeCloseTo(1, 6);
    expect(circularConcentration([0, 90, 180, 270])).toBeCloseTo(0, 6);
  });
});

describe("statistics helpers", () => {
  it("computes median and percentiles", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBeCloseTo(2.5, 9);
    expect(median([])).toBeNull();
    expect(percentile([0, 10], 0)).toBe(0);
    expect(percentile([0, 10], 100)).toBe(10);
    expect(percentile([0, 10, 20, 30], 50)).toBeCloseTo(15, 9);
  });
});

describe("positions", () => {
  it("rejects implausible fixes", () => {
    expect(isPlausiblePosition(58.7, 5.5)).toBe(true);
    expect(isPlausiblePosition(0, 0)).toBe(false);
    expect(isPlausiblePosition(NaN, 5)).toBe(false);
    expect(isPlausiblePosition(91, 5)).toBe(false);
    expect(isPlausiblePosition(58, 181)).toBe(false);
  });

  it("computes a longitude-safe centroid", () => {
    const c = centroid([
      { lat: 58.7, lon: 179.99 },
      { lat: 58.7, lon: -179.99 },
    ])!;
    expect(Math.abs(c.lon)).toBeCloseTo(180, 1);
    expect(c.lat).toBeCloseTo(58.7, 3);
  });
});
