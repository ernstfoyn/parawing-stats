/**
 * `GET /api/weather/observations`
 *
 * Fetches the wind observations for one chosen station and the session's time window. The client
 * pads the window slightly so interpolation has a bracketing observation on both sides.
 */

import { NextResponse } from "next/server";
import { serverProvider } from "@/lib/wind/server";
import { failure } from "@/lib/wind/server/types";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const providerId = url.searchParams.get("provider") ?? "";
  const stationId = url.searchParams.get("station") ?? "";
  const latRaw = url.searchParams.get("lat");
  const lonRaw = url.searchParams.get("lon");
  const from = Number(url.searchParams.get("from"));
  const to = Number(url.searchParams.get("to"));

  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return NextResponse.json(failure("bad_request", "A valid time range (from/to) is required."), {
      status: 400,
    });
  }

  const provider = serverProvider(providerId);
  if (!provider) {
    return NextResponse.json(
      failure("unsupported", `Unknown weather provider "${providerId}".`, null),
      { status: 400 },
    );
  }
  if (!stationId) {
    return NextResponse.json(failure("bad_request", "A station id is required.", null), {
      status: 400,
    });
  }

  const result = await provider.fetchObservations({
    stationId,
    lat: latRaw != null && Number.isFinite(Number(latRaw)) ? Number(latRaw) : null,
    lon: lonRaw != null && Number.isFinite(Number(lonRaw)) ? Number(lonRaw) : null,
    from,
    to,
  });

  if (!result.ok) {
    return NextResponse.json(result.failure, { status: result.failure.code === "bad_request" ? 400 : 200 });
  }
  return NextResponse.json({ ok: true, data: result.data, notes: result.notes });
}
