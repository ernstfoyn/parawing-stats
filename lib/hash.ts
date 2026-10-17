/** Content hashing used for duplicate-import detection. */

/**
 * SHA-256 of a byte buffer as lowercase hex.
 *
 * Uses Web Crypto, which is present in browsers and in Node 18+, so the importer stays isomorphic
 * and the same hash is produced on both sides.
 */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
