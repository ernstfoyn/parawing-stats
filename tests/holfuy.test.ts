import { describe, expect, it } from "vitest";
import {
  holfuySamplesFromSeries,
  parseHolfuyArchive,
  parseHolfuyPublicFile,
  seriesOffsetMin,
} from "@/lib/wind/server/holfuy";

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

/**
 * The public station page route — no password, which is the normal case: every Norwegian station
 * answers no_access at the API. The fixture is cut down from a real station file.
 */
const PUBLIC_FILE = `var unt = ['2026/11/17 10:15:00','2026/11/17 10:19:30'];
var gd_temp = [1.6,1.7];
var gd_speed = [18,36];
var gd_gust = [25,65];
var gd_direction = [200,210];
var gd_min_wind = [2,3];`;

describe("parseHolfuyPublicFile", () => {
  it("reads the published arrays", () => {
    const series = parseHolfuyPublicFile(PUBLIC_FILE)!;
    expect(series.times).toHaveLength(2);
    expect(series.speedKmh).toEqual([18, 36]);
    expect(series.gustKmh).toEqual([25, 65]);
    expect(series.dirFromDeg).toEqual([200, 210]);
    expect(series.tempC).toEqual([1.6, 1.7]);
  });

  it("returns nothing when there is no time array", () => {
    expect(parseHolfuyPublicFile("var gd_speed = [1,2];")).toBeNull();
    expect(parseHolfuyPublicFile("")).toBeNull();
  });
});

describe("seriesOffsetMin", () => {
  it("derives the station's offset from its newest point against the clock", () => {
    // Newest point is 10:19 local. If the clock says 09:24 UTC, the station is an hour ahead.
    const series = parseHolfuyPublicFile(PUBLIC_FILE)!;
    const now = Date.parse("2026-11-17T09:24:00Z");
    expect(seriesOffsetMin(series, now)).toBe(60);
  });

  it("handles a summer offset rather than assuming winter time", () => {
    const series = parseHolfuyPublicFile(
      `var unt = ['2026/07/01 12:00:00'];\nvar gd_speed = [10];`,
    )!;
    const now = Date.parse("2026-07-01T10:05:00Z"); // CEST: two hours ahead
    expect(seriesOffsetMin(series, now)).toBe(120);
  });

  it("refuses to guess when the station has been offline for hours", () => {
    const series = parseHolfuyPublicFile(PUBLIC_FILE)!;
    const now = Date.parse("2026-11-19T09:24:00Z"); // two days stale
    expect(seriesOffsetMin(series, now)).toBeNull();
  });
});

describe("holfuySamplesFromSeries", () => {
  it("converts km/h to m/s and shifts local time to UTC", () => {
    const series = parseHolfuyPublicFile(PUBLIC_FILE)!;
    const from = Date.parse("2026-11-17T09:00:00Z");
    const to = Date.parse("2026-11-17T10:00:00Z");
    const samples = holfuySamplesFromSeries(series, 60, from, to, "1542");
    expect(samples).toHaveLength(2);
    // 36 km/h is 10 m/s: a file read in m/s would be a hurricane and a session ruined.
    expect(samples[1].speedMps).toBeCloseTo(10, 6);
    expect(samples[1].gustMps!).toBeCloseTo(65 / 3.6, 6);
    expect(samples[1].dirFromDeg).toBe(210);
    // 10:19 local at UTC+1 is 09:19 UTC.
    expect(new Date(samples[1].t).toISOString()).toBe("2026-11-17T09:19:30.000Z");
    expect(samples[1].quality).toBe("measured");
    expect(samples[1].stationId).toBe("1542");
  });

  it("keeps only the session window", () => {
    const series = parseHolfuyPublicFile(PUBLIC_FILE)!;
    // The two points are 09:15Z and 09:19:30Z once the +1 h offset is removed; this window holds one.
    const from = Date.parse("2026-11-17T09:15:00Z");
    const to = Date.parse("2026-11-17T09:18:00Z");
    const samples = holfuySamplesFromSeries(series, 60, from, to, "1542");
    expect(samples).toHaveLength(1);
    expect(samples[0].dirFromDeg).toBe(200);
  });

  it("returns nothing for a session the five-day window does not reach", () => {
    const series = parseHolfuyPublicFile(PUBLIC_FILE)!;
    const from = Date.parse("2026-10-01T09:00:00Z");
    const to = Date.parse("2026-10-01T12:00:00Z");
    expect(holfuySamplesFromSeries(series, 60, from, to, "1542")).toEqual([]);
  });
});
