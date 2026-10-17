/**
 * Copies MapLibre's worker bundle into `public/` so the map can run in Turbopack.
 *
 * MapLibre GL v6 guesses its worker URL from `import.meta.url`. Under Turbopack that resolves to a
 * bundled chunk URL, so the derived `./maplibre-gl-worker.mjs` request 404s and (in dev) comes back
 * as the HTML error page. A worker that never loads means GeoJSON sources never finish, which means
 * `map.on("load")` never fires: no controls, no track, no markers.
 *
 * Serving the worker from `public/` and pointing MapLibre at it with `setWorkerUrl()` fixes that.
 * The file is copied rather than vendored so it always matches the installed MapLibre version.
 *
 * Runs automatically via the `predev` / `prebuild` / `prestart` npm scripts.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = require.resolve("maplibre-gl/package.json");
const source = join(dirname(pkgPath), "dist", "maplibre-gl-worker.mjs");
const target = join(root, "public", "maplibre-gl-worker.mjs");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`[copy-maplibre-worker] public/maplibre-gl-worker.mjs updated`);
