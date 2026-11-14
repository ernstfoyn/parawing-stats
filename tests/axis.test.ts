import { describe, expect, it } from "vitest";
import { axisDistance, axisIsUsable, estimateWindAxis } from "@/lib/wind/axis";
import { syntheticEnriched } from "./helpers";

/**
 * A beat with the wind from 190°: close-hauled on starboard at 150°, on port at 230°, alternating.
 * Nothing in this fixture tells the estimator the wind direction — only the headings do.
 */
function beat(windAxis = 190) {
  const a = windAxis - 40;
  const b = windAxis + 40;
  return syntheticEnriched(
    [
      { headingDeg: a, speedMps: 6, seconds: 120 },
      { headingDeg: b, speedMps: 6, seconds: 120 },
      { headingDeg: a, speedMps: 6, seconds: 120 },
      { headingDeg: b, speedMps: 6, seconds: 120 },
    ],
    { windFromDeg: windAxis },
  );
}

describe("estimateWindAxis", () => {
  it("finds the axis a symmetric beat is sailed about, without being told the wind", () => {
    const est = estimateWindAxis(beat(190));
    expect(est.axisDeg).not.toBeNull();
    // Within a couple of degrees of 190, which folds to 10.
    expect(axisDistance(est, 190)).toBeLessThan(3);
    // The rider sailed both tacks evenly, which is what makes the bisector trustworthy.
    expect(est.balance).toBeGreaterThan(0.9);
    expect(est.usedS).toBeGreaterThan(400);
    // And both halves of the session agree about it, which is what makes it more than a coincidence.
    expect(est.stabilityDeg).not.toBeNull();
    expect(est.stabilityDeg!).toBeLessThan(5);
    expect(axisIsUsable(est)).toBe(true);
  });

  it("works out the same axis from a set of gybes as from a set of tacks", () => {
    // Downwind headings sit either side of the downwind direction, 180° from the wind source.
    const points = syntheticEnriched(
      [
        { headingDeg: 190 + 180 - 35, speedMps: 9, seconds: 120 },
        { headingDeg: 190 + 180 + 35, speedMps: 9, seconds: 120 },
        { headingDeg: 190 + 180 - 35, speedMps: 9, seconds: 120 },
        { headingDeg: 190 + 180 + 35, speedMps: 9, seconds: 120 },
      ],
      { windFromDeg: 190 },
    );
    const est = estimateWindAxis(points);
    expect(axisDistance(est, 190)).toBeLessThan(3);
  });

  it("returns an axis modulo 180, because the geometry cannot tell the two ends apart", () => {
    const est = estimateWindAxis(beat(190));
    expect(est.axisDeg!).toBeGreaterThanOrEqual(0);
    expect(est.axisDeg!).toBeLessThan(180);
  });

  it("withholds the axis for courses with no symmetry in them", () => {
    // A square of headings has no preferred axis. It still produces *some* line, which is why the
    // stability check exists: the two halves of this session disagree about it completely.
    const points = syntheticEnriched(
      [
        { headingDeg: 0, speedMps: 6, seconds: 90 },
        { headingDeg: 45, speedMps: 6, seconds: 90 },
        { headingDeg: 90, speedMps: 6, seconds: 90 },
        { headingDeg: 135, speedMps: 6, seconds: 90 },
      ],
      { windFromDeg: 190 },
    );
    const est = estimateWindAxis(points);
    expect(axisIsUsable(est)).toBe(false);
  });

  it("refuses to state an axis when the rider mostly sailed one tack", () => {
    // 85% on starboard, 15% on port: the bisector leans toward the tack that was sailed most, so the
    // split is the honest warning rather than the number.
    const points = syntheticEnriched(
      [
        { headingDeg: 150, speedMps: 6, seconds: 510 },
        { headingDeg: 230, speedMps: 6, seconds: 90 },
      ],
      { windFromDeg: 190 },
    );
    const est = estimateWindAxis(points);
    expect(est.balance).toBeLessThan(0.4);
    expect(axisIsUsable(est)).toBe(false);
  });

  it("keeps the axis when a wide tack angle is sailed evenly", () => {
    // 80° between tacks is a wide beat. An earlier version judged symmetry by the strength of the
    // doubled-heading signal, which shrinks as the tack angle widens and scored this 0.17 — a good
    // estimate rejected for being wide. Balance does not care how wide the tack was.
    const points = syntheticEnriched(
      [
        { headingDeg: 110, speedMps: 6, seconds: 180 },
        { headingDeg: 270, speedMps: 6, seconds: 180 },
        { headingDeg: 110, speedMps: 6, seconds: 180 },
        { headingDeg: 270, speedMps: 6, seconds: 180 },
      ],
      { windFromDeg: 190 },
    );
    const est = estimateWindAxis(points);
    expect(est.balance).toBeGreaterThan(0.9);
    // The doubled-heading mean lands 90° out for a tack this wide; the balance picks the right line.
    expect(axisDistance(est, 190)).toBeLessThan(3);
  });

  it("says nothing at all when the session holds nothing to read", () => {
    expect(estimateWindAxis([])).toEqual({
      axisDeg: null,
      balance: 0,
      stabilityDeg: null,
      usedS: 0,
      used: 0,
    });
  });

  it("ignores time the rider was not moving", () => {
    const points = syntheticEnriched(
      [
        { headingDeg: 150, speedMps: 6, seconds: 120 },
        { headingDeg: 230, speedMps: 6, seconds: 120 },
        { headingDeg: 80, speedMps: 0.2, seconds: 300 }, // parked, bearing is noise
      ],
      { windFromDeg: 190 },
    );
    const est = estimateWindAxis(points);
    expect(axisDistance(est, 190)).toBeLessThan(6);
  });
});

describe("axisDistance", () => {
  it("compares against whichever end of the axis is nearer", () => {
    const axis = { axisDeg: 10, balance: 1, stabilityDeg: 0, usedS: 600, used: 100 };
    expect(axisDistance(axis, 10)).toBeLessThan(0.001);
    expect(axisDistance(axis, 190)).toBeLessThan(0.001);
    expect(axisDistance(axis, 25)).toBeCloseTo(15, 6);
  });

  it("says nothing when there is no axis or no direction", () => {
    expect(axisDistance({ axisDeg: null, balance: 0, stabilityDeg: null, usedS: 0, used: 0 }, 190)).toBeNull();
    expect(axisDistance({ axisDeg: 10, balance: 1, stabilityDeg: 0, usedS: 600, used: 100 }, null)).toBeNull();
  });
});
