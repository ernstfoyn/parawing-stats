import { describe, expect, it } from "vitest";
import { parseHolfuyArchive } from "@/lib/wind/server/holfuy";

/**
 * The shape below is copied from a real response of
 * `https://api.holfuy.com/archive/?s=101&start_date=2026-10-15&stop_date=2026-10-16&m=JSON&su=m/s&tu=C`.
 *
 * The rider's own stations need a password, so the live API cannot be exercised in a test — but the
 * response shape can, and that is where a parser breaks.
 */
const REAL_SHAPE = {
  stationId: 101,
  speedUnit: "m/s",
  tempUnit: "C",
  measurements: [
    {
      dateTime: "2026-10-16 00:00:00",
      wind: { speed: 4.2, gust: 7.1, min: 2.0, direction: 275 },
      temperature: 8.1,
      humidity: "11.1",
      pressure: "999.4",
      rain: 0,
    },
    {
      dateTime: "2026-10-15 23:00:00",
      wind: { speed: 0, gust: 0, min: 0, direction: 258 },
      temperature: 10.5,
      humidity: "0.0",
      pressure: "1001.7",
      rain: 0,
    },
  ],
};

describe("parseHolfuyArchive", () => {
  it("reads speed, gust and direction as numbers, in m/s", () => {
    const samples = parseHolfuyArchive(REAL_SHAPE, "1199");
    expect(samples).toHaveLength(2);
    // Rows come back oldest first, so pick the one with wind in it rather than by index.
    const windy = samples.find((s) => s.speedMps === 4.2)!;
    expect(windy).toBeDefined();
    expect(windy.gustMps).toBeCloseTo(7.1, 6);
    expect(windy.dirFromDeg).toBe(275);
    expect(windy.tempC).toBeCloseTo(8.1, 6);
    expect(windy.quality).toBe("measured");
    expect(windy.providerId).toBe("holfuy");
    expect(windy.stationId).toBe("1199");
  });

  it("orders the rows oldest first, whatever order Holfuy lists them in", () => {
    const samples = parseHolfuyArchive(REAL_SHAPE);
    expect(samples[0].t).toBeLessThan(samples[1].t);
  });

  it("treats Holfuy's stamp as UTC, which is what the request asks for", () => {
    const samples = parseHolfuyArchive(REAL_SHAPE);
    expect(new Date(samples[0].t).toISOString()).toBe("2026-10-15T23:00:00.000Z");
    expect(new Date(samples[1].t).toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });

  it("keeps a zero wind speed as zero rather than turning it into missing data", () => {
    const samples = parseHolfuyArchive(REAL_SHAPE);
    expect(samples[0].speedMps).toBe(0);
    expect(samples[0].speedMps).not.toBeNull();
  });

  it("carries on past a malformed row instead of dropping the whole archive", () => {
    const samples = parseHolfuyArchive({
      measurements: [
        { dateTime: "2026-10-15 10:00:00", wind: { speed: 5, direction: 200 } },
        { dateTime: "not a date", wind: { speed: 5, direction: 200 } },
        { wind: { speed: 5, direction: 200 } },
        { dateTime: "2026-10-15 11:00:00", wind: { speed: 6, direction: 210 } },
      ],
    });
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.speedMps)).toEqual([5, 6]);
  });

  it("says nothing rather than guessing when there is no wind object", () => {
    const samples = parseHolfuyArchive({
      measurements: [{ dateTime: "2026-10-15 10:00:00", temperature: 12 }],
    });
    expect(samples).toHaveLength(1);
    expect(samples[0].speedMps).toBeNull();
    expect(samples[0].gustMps).toBeNull();
    expect(samples[0].dirFromDeg).toBeNull();
  });

  it("returns nothing for an access error, so a refusal is never read as calm weather", () => {
    expect(parseHolfuyArchive({ error: "No access" })).toEqual([]);
    expect(parseHolfuyArchive({ stationId: 1199, error: "Sorry, you don't have access for this station.", errorCode: "no_access" })).toEqual([]);
    expect(parseHolfuyArchive(null)).toEqual([]);
    expect(parseHolfuyArchive({ measurements: [] })).toEqual([]);
  });
});
