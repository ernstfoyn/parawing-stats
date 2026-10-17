/**
 * Import entry point.
 *
 * The activity-import layer is deliberately a single function per format behind a tiny dispatch,
 * so adding Strava or Garmin Connect downloads later means adding a `parseX` function and nothing
 * else changes.
 */

import { hashBytes } from "../hash";
import type { ActivityFormat } from "../types";
import { parseFit } from "./fit";
import { parseGpx } from "./gpx";
import { ImportError, type ParsedActivity } from "./types";

export { parseFit } from "./fit";
export { parseGpx } from "./gpx";
export { ImportError } from "./types";
export type { ParsedActivity } from "./types";

/** Detect the container format from the file name first, then from the content. */
export function detectFormat(fileName: string, bytes: ArrayBuffer): ActivityFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".fit")) return "fit";
  if (lower.endsWith(".gpx")) return "gpx";
  // FIT files carry the ASCII signature ".FIT" at byte offset 8 of the header.
  if (bytes.byteLength > 12) {
    const sig = new Uint8Array(bytes, 8, 4);
    if (sig[0] === 0x2e && sig[1] === 0x46 && sig[2] === 0x49 && sig[3] === 0x54) return "fit";
  }
  // Fall back to sniffing for XML.
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512)).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<gpx")) return "gpx";
  throw new ImportError(
    `Unsupported file type: ${fileName}`,
    "Foil Analyzer reads Garmin/Strava .fit files and .gpx tracks. Export your activity as one of those.",
  );
}

/** Parse a file's bytes. Synchronous, pure, and therefore easy to test. */
export function parseActivityBytes(
  bytes: ArrayBuffer,
  fileName: string,
  format?: ActivityFormat,
): ParsedActivity {
  const fmt = format ?? detectFormat(fileName, bytes);
  const parsed =
    fmt === "fit" ? parseFit(bytes, fileName) : parseGpx(new TextDecoder("utf-8").decode(bytes), fileName);
  parsed.meta.format = fmt;
  return parsed;
}

export interface ImportedFile {
  bytes: ArrayBuffer;
  fileName: string;
}

/** Browser helper: read a `File`/`Blob` into the raw parsed activity plus its content hash. */
export async function readActivityFile(
  file: File,
): Promise<{ parsed: ParsedActivity; hash: string; size: number }> {
  const bytes = await file.arrayBuffer();
  const hash = await hashBytes(bytes);
  const parsed = parseActivityBytes(bytes, file.name);
  parsed.meta.fileHash = hash;
  parsed.meta.fileName = file.name;
  return { parsed, hash, size: file.size };
}
