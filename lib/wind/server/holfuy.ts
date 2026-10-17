/**
 * Holfuy provider — deliberately incomplete, and honest about it.
 *
 * Holfuy stations are often the best possible source (they sit at the spot), but their free API
 * only exposes the *latest* reading. Retrieving the wind for a session from last Saturday needs
 * their commercial history API, which requires credentials and a licence. Rather than presenting
 * a live reading as if it were the historical conditions, this provider reports that it cannot
 * answer, and the UI falls back to Frost, Open-Meteo or manual entry.
 *
 * Wiring a real implementation later means: add `listStations` (a station directory request) and
 * `fetchObservations` (the history endpoint) here. Nothing else in the app changes.
 */

import type { ServerProvider } from "./types";

export function holfuyConfigured(): boolean {
  return Boolean(process.env.HOLFUY_API_KEY);
}

export const holfuyProvider: ServerProvider = {
  id: "holfuy",

  async listStations() {
    if (!holfuyConfigured()) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "no_key",
          error: "Holfuy is not configured on this server.",
          hint: "Set HOLFUY_API_KEY to enable Holfuy. Historical wind still requires Holfuy's history API; without it, use Frost, Open-Meteo or manual entry.",
        },
      };
    }
    return {
      ok: false,
      failure: {
        ok: false,
        code: "unsupported",
        error: "Holfuy historical wind is not implemented.",
        hint: "Holfuy's free API returns only the current reading, which would be wrong for a past session. Historical retrieval needs their commercial API. Use Frost (Norway), Open-Meteo (modelled, global) or enter the wind manually.",
      },
    };
  },

  async fetchObservations() {
    return {
      ok: false,
      failure: {
        ok: false,
        code: "unsupported",
        error: "Holfuy historical wind is not implemented.",
        hint: "Holfuy's free API returns only the current reading. Enter the wind manually instead.",
      },
    };
  },
};
