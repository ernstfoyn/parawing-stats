import { describe, expect, it } from "vitest";
import {
  compassPoint,
  convertSpeed,
  formatDirection,
  formatDistance,
  formatDuration,
  formatSpeed,
  knotsToMps,
  mpsToKmh,
  mpsToKnots,
  toMps,
} from "@/lib/units";

describe("speed conversion", () => {
  it("converts m/s to knots and back", () => {
    expect(mpsToKnots(1)).toBeCloseTo(1.943844, 5);
    expect(knotsToMps(mpsToKnots(9.4))).toBeCloseTo(9.4, 9);
  });

  it("converts m/s to km/h", () => {
    expect(mpsToKmh(10)).toBeCloseTo(36, 9);
  });

  it("is consistent between convertSpeed and toMps", () => {
    for (const unit of ["kn", "mps", "kmh"] as const) {
      expect(toMps(convertSpeed(7.3, unit), unit)).toBeCloseTo(7.3, 9);
    }
  });

  it("formats speeds for display", () => {
    expect(formatSpeed(10, "kn")).toBe("19.4");
    expect(formatSpeed(10, "mps")).toBe("10.0");
    expect(formatSpeed(null, "kn")).toBe("—");
  });
});

describe("direction helpers", () => {
  it("names compass points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(300)).toBe("WNW");
    expect(compassPoint(359)).toBe("N");
    expect(formatDirection(300)).toBe("WNW 300°");
  });
});

describe("formatting", () => {
  it("formats distances with sensible units", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(950)).toBe("950 m");
    expect(formatDistance(12345)).toBe("12.35 km");
  });

  it("formats durations", () => {
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(61)).toBe("1:01");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(null)).toBe("—");
  });
});
