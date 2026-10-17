import { describe, expect, it } from "vitest";
import { localityFromTitle, suggestActivityName } from "@/lib/naming";

describe("localityFromTitle", () => {
  it("takes the place out of the name a Garmin actually writes", () => {
    expect(localityFromTitle("Rygge SUP-surfing")).toBe("Rygge");
    expect(localityFromTitle("Larkollen wingfoil")).toBe("Larkollen");
    expect(localityFromTitle("Sletterøyene parawing session")).toBe("Sletterøyene");
    expect(localityFromTitle("windsurfing at Jeløya")).toBe("Jeløya");
  });

  it("returns nothing rather than a guess when the name is all activity", () => {
    expect(localityFromTitle("Morning Ride")).toBeNull();
    expect(localityFromTitle("Afternoon Activity")).toBeNull();
    expect(localityFromTitle("SUP session")).toBeNull();
    expect(localityFromTitle("Wingfoiling")).toBeNull();
    expect(localityFromTitle("Downwind run")).toBeNull();
    expect(localityFromTitle("")).toBeNull();
    expect(localityFromTitle(null)).toBeNull();
    expect(localityFromTitle(undefined)).toBeNull();
  });

  it("refuses dates and anything with a digit in it, but keeps the place they sit next to", () => {
    expect(localityFromTitle("2026-10-15 activity_24736830361")).toBeNull();
    // A version tag is not a place, and dropping it leaves the place that is there.
    expect(localityFromTitle("Rygge SUP-surfing v2")).toBe("Rygge");
    expect(localityFromTitle("Ride 3")).toBeNull();
    expect(localityFromTitle("15.10.2026 Rygge")).toBe("Rygge");
  });

  it("does not treat a whole sentence as a place", () => {
    expect(localityFromTitle("A long afternoon of downwind riding at Rygge")).toBeNull();
  });

  it("keeps a two or three word place", () => {
    expect(localityFromTitle("Indre Oslofjord wingfoil")).toBe("Indre Oslofjord");
    expect(localityFromTitle("Nordstrand, Oslo")).toBe("Nordstrand Oslo");
  });
});

describe("suggestActivityName", () => {
  const startedAt = Date.UTC(2026, 9, 15, 13, 52, 0);

  it("leads with the date the rider was out and then the place", () => {
    expect(
      suggestActivityName({ startedAt, timezoneOffsetMin: 120, title: "Rygge SUP-surfing" }),
    ).toBe("15 Oct 2026 · Rygge");
  });

  it("falls back to the date alone rather than inventing a place", () => {
    expect(
      suggestActivityName({ startedAt, timezoneOffsetMin: 120, title: "Morning Ride" }),
    ).toBe("15 Oct 2026");
    expect(suggestActivityName({ startedAt, timezoneOffsetMin: 120 })).toBe("15 Oct 2026");
  });

  it("uses the file name only when the title has nothing", () => {
    expect(
      suggestActivityName({
        startedAt,
        timezoneOffsetMin: 120,
        title: null,
        fileName: "activity_24736830361.gpx",
      }),
    ).toBe("15 Oct 2026");
    expect(
      suggestActivityName({
        startedAt,
        timezoneOffsetMin: 120,
        title: null,
        fileName: "Rygge SUP-surfing.gpx",
      }),
    ).toBe("15 Oct 2026 · Rygge");
  });

  it("prefers a place resolved elsewhere over the file's own name", () => {
    expect(
      suggestActivityName({
        startedAt,
        timezoneOffsetMin: 120,
        title: "Rygge SUP-surfing",
        place: "Sletterøyene",
      }),
    ).toBe("15 Oct 2026 · Sletterøyene");
  });

  it("reads the date in the rider's own timezone, not UTC", () => {
    // 23:30 UTC on the 15th is the 16th in Oslo.
    const late = Date.UTC(2026, 9, 15, 23, 30, 0);
    expect(suggestActivityName({ startedAt: late, timezoneOffsetMin: 120 })).toBe("16 Oct 2026");
  });
});
