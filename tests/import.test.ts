import { describe, expect, it } from "vitest";
import { Encoder, Profile } from "@garmin/fitsdk";
import { detectFormat, parseActivityBytes, parseGpx } from "@/lib/import";
import { ImportError } from "@/lib/import/types";
import { parseFit } from "@/lib/import/fit";
import { hashBytes } from "@/lib/hash";

const GPX_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="Garmin Connect" version="1.1"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata><time>2025-06-14T12:00:00.000Z</time></metadata>
  <trk>
    <name>Parawing Jæren</name>
    <type>windsurfing</type>
    <trkseg>
      <trkpt lat="58.7345" lon="5.5215">
        <ele>0.4</ele>
        <time>2025-06-14T12:00:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>124</gpxtpx:hr>
            <gpxtpx:cad>0</gpxtpx:cad>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="58.7346" lon="5.5216">
        <ele>0.5</ele>
        <time>2025-06-14T12:00:01Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>125</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="58.7347" lon="5.5217">
        <ele>0.6</ele>
        <time>2025-06-14T12:00:02Z</time>
      </trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="58.7350" lon="5.5220">
        <ele>0.7</ele>
        <time>2025-06-14T12:00:40Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe("GPX import", () => {
  it("reads positions, timestamps, elevation and Garmin heart rate", () => {
    const { samples, meta } = parseGpx(GPX_FIXTURE, "test.gpx");
    expect(samples).toHaveLength(4);
    expect(samples[0].lat).toBeCloseTo(58.7345, 6);
    expect(samples[0].lon).toBeCloseTo(5.5215, 6);
    expect(samples[0].t).toBe(Date.UTC(2025, 5, 14, 12, 0, 0));
    expect(samples[0].ele).toBeCloseTo(0.4, 6);
    expect(samples[0].hr).toBe(124);
    expect(samples[2].hr).toBeNull();
    expect(meta.format).toBe("gpx");
    expect(meta.has.hr).toBe(true);
    expect(meta.has.ele).toBe(true);
    expect(meta.has.speed).toBe(false);
    expect(meta.warnings.join(" ")).toContain("speed is derived");
  });

  it("turns a track-segment break into an interruption", () => {
    const { meta } = parseGpx(GPX_FIXTURE);
    expect(meta.pauses).toHaveLength(1);
    expect(meta.pauses[0].start).toBe(Date.UTC(2025, 5, 14, 12, 0, 2));
    expect(meta.pauses[0].end).toBe(Date.UTC(2025, 5, 14, 12, 0, 40));
    expect(meta.warnings.join(" ")).toContain("2 track segments");
  });

  it("never invents a speed channel", () => {
    const { samples } = parseGpx(GPX_FIXTURE);
    expect(samples.every((s) => s.speed === null)).toBe(true);
  });

  it("reads a plain minimal GPX without extensions", () => {
    const minimal = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"><time>2025-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="1.001" lon="2.001"><time>2025-01-01T00:00:05Z</time></trkpt>
    </trkseg></trk></gpx>`;
    const { samples } = parseGpx(minimal);
    expect(samples).toHaveLength(2);
    expect(samples[0].hr).toBeNull();
    expect(samples[0].ele).toBeNull();
  });

  it("throws a helpful error for XML that is not a track", () => {
    expect(() => parseGpx("<html><body>nope</body></html>")).toThrow(ImportError);
    expect(() => parseGpx("<html><body>nope</body></html>")).toThrow(/does not look like GPX/);
    expect(() => parseGpx("<gpx></gpx>")).toThrow(/no track points/i);
  });

  it("throws when there are no timestamps", () => {
    const noTime = `<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`;
    expect(() => parseGpx(noTime)).toThrow(/timestamp/i);
  });

  it("treats a naive timestamp as UTC", () => {
    const naive = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"><time>2025-01-01T00:00:00</time></trkpt>
      <trkpt lat="1.001" lon="2.001"><time>2025-01-01T00:00:05</time></trkpt>
    </trkseg></trk></gpx>`;
    const { samples } = parseGpx(naive);
    expect(samples[0].t).toBe(Date.UTC(2025, 0, 1, 0, 0, 0));
  });

  it("preserves a non-standard UTC offset in the timestamps", () => {
    const offset = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"><time>2025-01-01T00:00:00+02:00</time></trkpt>
      <trkpt lat="1.001" lon="2.001"><time>2025-01-01T00:00:05+02:00</time></trkpt>
    </trkseg></trk></gpx>`;
    const { samples, meta } = parseGpx(offset);
    expect(samples[0].t).toBe(Date.UTC(2024, 11, 31, 22, 0, 0));
    expect(meta.warnings.join(" ")).toContain("UTC offset");
  });

  it("reads speed and course when a device writes them", () => {
    const withSpeed = `<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"><time>2025-01-01T00:00:00Z</time><speed>6.5</speed><course>181.4</course></trkpt>
      <trkpt lat="1.001" lon="2.001"><time>2025-01-01T00:00:05Z</time><speed>7</speed><course>182</course></trkpt>
    </trkseg></trk></gpx>`;
    const { samples, meta } = parseGpx(withSpeed);
    expect(samples[0].speed).toBeCloseTo(6.5, 6);
    expect(samples[0].cog).toBeCloseTo(181.4, 6);
    expect(meta.has.speed).toBe(true);
    expect(meta.has.cog).toBe(true);
  });
});

/** Build a small but complete FIT activity file with the official SDK encoder. */
function encodeFitActivity(): ArrayBuffer {
  const encoder = new Encoder();
  // The SDK's `Mesg` interface is closed, but it accepts any field record at runtime; cast once
  // here so the fixtures below read as plain data.
  const m = (fields: Record<string, unknown>) =>
    fields as unknown as Parameters<Encoder["onMesg"]>[1];
  encoder.onMesg(Profile.MesgNum.FILE_ID, m({
    type: "activity",
    manufacturer: "garmin",
    product: 1,
    serialNumber: 12345,
    timeCreated: new Date(Date.UTC(2025, 5, 14, 12, 0, 0)),
  }));
  encoder.onMesg(Profile.MesgNum.DEVICE_INFO, m({
    timestamp: new Date(Date.UTC(2025, 5, 14, 12, 0, 0)),
    productName: "Forerunner 965",
  }));

  const t0 = Date.UTC(2025, 5, 14, 12, 0, 0);
  const lat = 58.7345;
  const lon = 5.5215;
  for (let i = 0; i < 20; i++) {
    encoder.onMesg(Profile.MesgNum.RECORD, m({
      timestamp: new Date(t0 + i * 1000),
      positionLat: Math.round((lat + i * 0.00005) / (180 / 2147483648)),
      positionLong: Math.round((lon + i * 0.00005) / (180 / 2147483648)),
      speed: 6 + i * 0.1, // m/s, the encoder applies the profile's scale
      altitude: 1 + i,
      heartRate: 130 + i,
      distance: i * 6,
    }));
  }

  // A pause and a restart, encoded as timer events. The encoder wants the profile's own enum
  // names, which are what the decoder returns with `convertTypesToStrings`.
  encoder.onMesg(Profile.MesgNum.EVENT, m({
    timestamp: new Date(t0 + 5000),
    event: "timer",
    eventType: "stopAll",
  }));
  encoder.onMesg(Profile.MesgNum.EVENT, m({
    timestamp: new Date(t0 + 9000),
    event: "timer",
    eventType: "start",
  }));

  encoder.onMesg(Profile.MesgNum.SESSION, m({
    timestamp: new Date(t0 + 19_000),
    startTime: new Date(t0),
    sport: "windsurfing",
    totalDistance: 120,
    totalTimerTime: 20,
  }));

  return toArrayBuffer(encoder.close());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("FIT import", () => {
  it("decodes positions, speed, altitude, heart rate and distance", () => {
    const { samples, meta } = parseFit(encodeFitActivity(), "demo.fit");
    expect(samples).toHaveLength(20);
    expect(samples[0].lat).toBeCloseTo(58.7345, 4);
    expect(samples[0].lon).toBeCloseTo(5.5215, 4);
    expect(samples[0].t).toBe(Date.UTC(2025, 5, 14, 12, 0, 0));
    expect(samples[0].speed).toBeCloseTo(6, 2);
    expect(samples[5].hr).toBe(135);
    expect(samples[5].ele).toBeCloseTo(6, 2);
    expect(samples[5].deviceDistance).toBeCloseTo(30, 2);
    expect(meta.format).toBe("fit");
    expect(meta.has.speed).toBe(true);
    expect(meta.has.hr).toBe(true);
    expect(meta.has.ele).toBe(true);
  });

  it("does not mistake course over ground for a recorded value", () => {
    const { samples } = parseFit(encodeFitActivity());
    expect(samples.every((s) => s.cog === null)).toBe(true);
  });

  it("extracts timer pauses from event messages", () => {
    const { meta } = parseFit(encodeFitActivity());
    expect(meta.pauses).toHaveLength(1);
    expect(meta.pauses[0].start).toBe(Date.UTC(2025, 5, 14, 12, 0, 5));
    expect(meta.pauses[0].end).toBe(Date.UTC(2025, 5, 14, 12, 0, 9));
    expect(meta.warnings.join(" ")).toContain("paused");
  });

  it("reads the device name and start time", () => {
    const { meta } = parseFit(encodeFitActivity());
    expect(meta.device).toBe("Forerunner 965");
    expect(meta.timerStart).toBe(Date.UTC(2025, 5, 14, 12, 0, 0));
  });

  it("rejects a file that is not FIT", () => {
    const notFit = new TextEncoder().encode("hello world, definitely not a fit file");
    expect(() => parseFit(toArrayBuffer(notFit))).toThrow(/not a FIT file/i);
  });
});

describe("format detection", () => {
  it("uses the extension first", () => {
    const bytes = new ArrayBuffer(16);
    expect(detectFormat("activity.gpx", bytes)).toBe("gpx");
    expect(detectFormat("activity.fit", bytes)).toBe("fit");
  });

  it("sniffs the FIT signature when the extension is unhelpful", () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 14;
    bytes.set(new TextEncoder().encode(".FIT"), 8);
    expect(detectFormat("activity.bin", toArrayBuffer(bytes))).toBe("fit");
  });

  it("sniffs XML", () => {
    const xml = new TextEncoder().encode('<?xml version="1.0"?><gpx></gpx>');
    expect(detectFormat("activity.txt", toArrayBuffer(xml))).toBe("gpx");
  });

  it("throws a clear error for anything else", () => {
    const bytes = new TextEncoder().encode("random");
    expect(() => detectFormat("activity.csv", toArrayBuffer(bytes))).toThrow(/Unsupported file type/);
  });

  it("parses bytes through the shared entry point", () => {
    const fit = encodeFitActivity();
    expect(parseActivityBytes(fit, "x.fit").samples).toHaveLength(20);
    const gpx = new TextEncoder().encode(GPX_FIXTURE);
    expect(parseActivityBytes(toArrayBuffer(gpx), "x.gpx").samples).toHaveLength(4);
  });
});

describe("content hashing for duplicate detection", () => {
  it("is stable for identical content and different otherwise", async () => {
    const a = new TextEncoder().encode("same file bytes");
    const b = new TextEncoder().encode("same file bytes");
    const c = new TextEncoder().encode("different bytes");
    expect(await hashBytes(toArrayBuffer(a))).toBe(await hashBytes(toArrayBuffer(b)));
    expect(await hashBytes(toArrayBuffer(a))).not.toBe(await hashBytes(toArrayBuffer(c)));
    expect(await hashBytes(toArrayBuffer(a))).toMatch(/^[0-9a-f]{64}$/);
  });
});
