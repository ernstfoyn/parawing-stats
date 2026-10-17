/**
 * Weather provider status.
 *
 * Lets the dashboard show which providers this deployment can actually use (for example whether
 * FROST_CLIENT_ID is set) without leaking anything about the key itself.
 */

import { NextResponse } from "next/server";
import { PROVIDER_IDS, WEATHER_PROVIDERS } from "@/lib/wind/providers";
import { providerAvailability } from "@/lib/wind/server";

export async function GET() {
  const availability = providerAvailability();
  const providers = PROVIDER_IDS.map((id) => ({
    ...WEATHER_PROVIDERS[id],
    /** true when the server has everything it needs to call this provider */
    configured: availability[id],
  }));
  return NextResponse.json({ ok: true, providers });
}
