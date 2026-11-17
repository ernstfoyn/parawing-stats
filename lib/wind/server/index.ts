/** Provider dispatch for the route handlers. */

import { providerById } from "../providers";
import type { ProviderId } from "../../types";
import { frostProvider } from "./frost";
import { holfuyProvider, holfuyStationIds } from "./holfuy";
import { openMeteoProvider } from "./openMeteo";
import type { ServerProvider } from "./types";

const PROVIDERS: Record<string, ServerProvider> = {
  frost: frostProvider,
  "open-meteo": openMeteoProvider,
  holfuy: holfuyProvider,
};

export function serverProvider(id: string): ServerProvider | null {
  return PROVIDERS[id] ?? null;
}

/** Providers the UI should show as configured, given the server environment. */
export function providerAvailability(): Record<ProviderId, boolean> {
  return {
    frost: Boolean(process.env.FROST_CLIENT_ID),
    "open-meteo": true,
    // Holfuy needs a *station*, not a password: without one it reads the station's public page, which
    // publishes about five days of history. A password only widens that to their documented API.
    holfuy: holfuyStationIds().length > 0,
  };
}

export { providerById };
export type { ServerProvider };
