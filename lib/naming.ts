/**
 * Naming an activity.
 *
 * A rider's session arrives as `activity_24736830361.gpx`, and calling the activity that is useless:
 * the file name is a device dump, not an answer to "which session is this". What a rider recognises
 * is *when* and *where*, so that is what the name is built from: `15 Oct 2026 · Rygge`.
 *
 * The place comes from the file's own activity name when it has one, which costs nothing and keeps
 * the rider's coordinates on their own machine. A Garmin writes `<name>Rygge SUP-surfing</name>`, and
 * the place is in there — it just has to be told apart from the sport, the date and the word
 * "session". That is all `localityFromTitle` does, and it answers `null` rather than guessing when it
 * cannot tell: a wrong place name is worse than no place name, and the date alone is still a name.
 *
 * Nothing here contacts a network. Reverse-geocoding a bare coordinate pair would give a place for a
 * file that carries no name at all, but it means sending the rider's position to a third party, which
 * a local-first log should not do behind their back.
 */

import { formatDateInOffset } from "./units";

/**
 * Words that describe the *activity* rather than the place. Compared case-insensitively and after
 * stripping a trailing version suffix, so `stand_up_paddleboarding_v2` and `SUP-surfing` both go.
 */
const ACTIVITY_WORDS = new Set([
  "activity",
  "cycle",
  "downwind",
  "foil",
  "foiling",
  "kite",
  "kitesurf",
  "kitesurfing",
  "morning",
  "afternoon",
  "evening",
  "night",
  "parawing",
  "paddle",
  "paddleboarding",
  "ride",
  "row",
  "run",
  "sail",
  "sailing",
  "session",
  "stand",
  "sup",
  "surf",
  "surfing",
  "swim",
  "test",
  "training",
  "upwind",
  "walk",
  "wave",
  "wing",
  "wingfoil",
  "wingfoiling",
  "windsurf",
  "windsurfing",
  "workout",
]);

/**
 * Connective words that carry no place, so "windsurfing at Jeløya" still gives "Jeløya".
 */
const CONNECTORS = new Set([
  "at",
  "by",
  "fra",
  "i",
  "in",
  "near",
  "of",
  "on",
  "pa",
  "the",
  "ved",
  "with",
]);

/** A title that is only a date or a time is not a place. */
const DATE_LIKE = /^(\d{4}[-._/]\d{1,2}[-._/]\d{1,2}|\d{1,2}[-._/]\d{1,2}[-._/]\d{2,4}|\d{1,2}[:.]\d{2}(:\d{2})?(\s*[ap]m)?)$/i;

function hasDigit(s: string): boolean {
  return /\d/.test(s);
}

/**
 * The place inside an activity's own name, or null when there is not one to be sure of.
 *
 * Kept deliberately conservative: it returns at most three words, drops anything with a digit in it
 * (dates, version tags, "Ride 3"), and refuses a result that is entirely generic words. "Rygge
 * SUP-surfing" gives "Rygge"; "Morning Ride" gives nothing.
 */
export function localityFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const tokens = title
    .replace(/[_\-–—/|,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0)
    .filter((t) => !DATE_LIKE.test(t))
    .filter((t) => !hasDigit(t))
    // "SUP-surfing" arrives as two tokens after the separator split; drop known activity words.
    .filter((t) => !ACTIVITY_WORDS.has(t.toLowerCase()))
    .filter((t) => !CONNECTORS.has(t.toLowerCase()))
    // Anything that *contains* an activity word as a whole-part is also about the activity, e.g.
    // "Wingfoiling", "kitesurf", "wingfoil-session".
    .filter((t) => !/^(sup|wing|kite|surf|paddl|foil|windsurf)/i.test(t));

  if (tokens.length === 0) return null;
  // A place name is a proper noun, not a sentence.
  if (tokens.length > 3) return null;
  if (!tokens.every((t) => /^[A-ZÆØÅ][\p{L}.'’-]*$/u.test(t))) return null;
  return tokens.join(" ");
}

export interface NameSuggestionInput {
  startedAt: number;
  timezoneOffsetMin: number | null;
  /** the activity's own name from the file, e.g. "Rygge SUP-surfing" */
  title?: string | null;
  /** a place already resolved elsewhere (e.g. a chosen weather station's locality) */
  place?: string | null;
  /** the imported file's name, the last resort when the title is empty */
  fileName?: string;
}

/** `15 Oct 2026 · Rygge`, or just the date when there is no place to be sure of. */
export function suggestActivityName(input: NameSuggestionInput): string {
  const date = formatDateInOffset(input.startedAt, input.timezoneOffsetMin);
  const place =
    clean(input.place) ??
    localityFromTitle(input.title) ??
    localityFromTitle(input.fileName?.replace(/\.(fit|gpx)$/i, "") ?? null);
  return place ? `${date} · ${place}` : date;
}

function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t && t.length > 0 ? t : null;
}
