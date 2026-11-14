import { describe, expect, it } from "vitest";
import { directionConsensus, type DirectionReport } from "@/lib/wind/consensus";

const station = (id: string, dirFromDeg: number | null, distanceKm: number | null, n = 10): DirectionReport => ({
  id,
  name: id,
  distanceKm,
  dirFromDeg,
  speedMps: 8,
  observationCount: n,
});

describe("directionConsensus", () => {
  it("reports a direction when the nearby stations agree", () => {
    const c = directionConsensus([
      station("a", 194, 5),
      station("b", 197, 9),
      station("c", 192, 14),
    ]);
    expect(c.used).toBe(3);
    expect(c.dirFromDeg).toBeCloseTo(194, 0);
    expect(c.spreadDeg).toBeLessThanOrEqual(3);
    expect(c.agreed).toBe(true);
  });

  it("says they do not agree when they do not, instead of averaging it away", () => {
    // Two stations 60° apart: averaging them would produce a confident 220 that describes neither.
    const c = directionConsensus([station("a", 190, 5), station("b", 250, 6)]);
    expect(c.reported).toBe(2);
    expect(c.used).toBe(1);
    expect(c.agreed).toBe(true); // the group of one is tight; the disagreement is the outlier
    expect(c.outliers).toHaveLength(1);
  });

  it("keeps a lone inland station from poisoning three agreeing coastal ones", () => {
    // The rider's own session: the three coastal stations agreed at 193-205°, and an inland station at
    // a motorway reported 96° from the same distance. Averaging all four describes none of them.
    const c = directionConsensus([
      station("rygge", 202, 9.2),
      station("gullholmen", 193, 16.1),
      station("strømtangen", 205, 18.5),
      station("e18-tveiten", 96, 18.8),
    ]);
    expect(c.reported).toBe(4);
    expect(c.used).toBe(3);
    expect(c.dirFromDeg!).toBeGreaterThan(190);
    expect(c.dirFromDeg!).toBeLessThan(205);
    expect(c.spreadDeg!).toBeLessThanOrEqual(13);
    expect(c.agreed).toBe(true);
    expect(c.outliers.map((o) => o.id)).toEqual(["e18-tveiten"]);
  });

  it("weights the closer station more heavily", () => {
    const near = directionConsensus([station("near", 200, 2), station("far", 180, 40)]);
    expect(near.dirFromDeg!).toBeGreaterThan(195);
    const far = directionConsensus([station("near", 200, 40), station("far", 180, 2)]);
    expect(far.dirFromDeg!).toBeLessThan(185);
  });

  it("averages across the north wrap rather than through it", () => {
    const c = directionConsensus([station("a", 355, 5), station("b", 5, 5)]);
    // The mean of 355 and 5 is 360 (= 0), never 180.
    expect(c.dirFromDeg! < 5 || c.dirFromDeg! > 355).toBe(true);
    expect(c.spreadDeg!).toBeLessThanOrEqual(5);
  });

  it("ignores a station that reported no direction, rather than inventing one", () => {
    const c = directionConsensus([
      station("nodir", null, 2),
      station("ok", 200, 12),
      station("empty", 210, 8, 0),
    ]);
    expect(c.used).toBe(1);
    expect(c.reported).toBe(1);
    expect(c.dirFromDeg).toBeCloseTo(200, 0);
  });

  it("says nothing at all when no station reported a direction", () => {
    const c = directionConsensus([station("a", null, 5), station("b", null, 9)]);
    expect(c.dirFromDeg).toBeNull();
    expect(c.used).toBe(0);
    expect(c.reported).toBe(0);
    expect(c.agreed).toBe(false);
  });

  it("still votes for a station whose distance is unknown, as Holfuy's is", () => {
    const c = directionConsensus([station("no-distance", 200, null)]);
    expect(c.used).toBe(1);
    expect(c.dirFromDeg).toBeCloseTo(200, 0);
  });

  it("returns nothing for an empty list", () => {
    expect(directionConsensus([])).toEqual({
      dirFromDeg: null,
      used: 0,
      reported: 0,
      spreadDeg: null,
      agreed: false,
      outliers: [],
    });
  });
});
