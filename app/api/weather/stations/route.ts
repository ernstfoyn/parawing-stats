/**
 * `GET /api/weather/stations`
 *
 * Finds candidate wind stations for a session. The coordinates sent here are the centroid of the
 * GPS track; the time range is the session's, so providers can report which stations actually have
 * data for that hour.
 *
 * The response is always JSON with an `ok` flag, so the client can show a specific, honest error
 * (missing key, station offline, rate limit) instead of a generic failure.
 */

import { NextResponse } from "next/server";
import { serverProvider } from "@/lib/wind/server";
import { failure } from "@/lib/wind/server/types";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const providerId = url.searchParams.get("provider") ?? "";
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));
  const radiusKm = Number(url.searchParams.get("radiusKm") ?? "50");

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      failure("bad_request", "Valid lat/lon coordinates are required."),
      { status: 400 },
    );
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return NextResponse.json(
      failure("bad_request", "A valid session time range (from/to) is required."),
      { status: 400 },
    );
  }

  const provider = serverProvider(providerId);
  if (!provider) {
    return NextResponse.json(
      failure("unsupported", `Unknown weather provider "${providerId}".`, null),
      { status: 400 },
    );
  }

  const result = await provider.listStations({
    lat,
    lon,
    from,
    to,
    radiusKm: Number.isFinite(radiusKm) ? Math.min(Math.max(radiusKm, 1), 300) : 50,
  });

  if (!result.ok) {
    return NextResponse.json(result.failure, { status: result.failure.code === "bad_request" ? 400 : 200 });
  }
  return NextResponse.json({ ok: true, data: result.data, notes: result.notes });
}
