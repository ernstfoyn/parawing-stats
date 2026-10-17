/**
 * IndexedDB storage.
 *
 * A session's track can be a few thousand points, so it does not belong in localStorage. This
 * wrapper is intentionally tiny: three object stores, promise-based helpers, and a localStorage
 * fallback for browsers where IndexedDB is unavailable (some private-browsing modes).
 *
 * The split between the `sessions` store (immutable track data) and the `meta` store (everything
 * the rider can edit) means a segment relabel rewrites a few kilobytes instead of megabytes.
 */

/**
 * Storage identifiers, deliberately frozen at their original value.
 *
 * These are not the product name: they are the keys of data already sitting in the rider's browser.
 * Renaming the database would make every session they have imported look deleted, so it only changes
 * alongside a migration that carries the old data across.
 */
const DB_NAME = "foil-analyzer";
const DB_VERSION = 1;

export const STORES = {
  sessions: "sessions",
  meta: "meta",
  settings: "settings",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

interface StoreDefinition {
  name: StoreName;
  keyPath: string;
  indexes?: { name: string; keyPath: string; unique?: boolean }[];
}

const DEFINITIONS: StoreDefinition[] = [
  {
    name: STORES.sessions,
    keyPath: "id",
    indexes: [{ name: "fileHash", keyPath: "fileHash" }, { name: "importedAt", keyPath: "importedAt" }],
  },
  { name: STORES.meta, keyPath: "id" },
  { name: STORES.settings, keyPath: "key" },
];

let dbPromise: Promise<IDBDatabase> | null = null;
let memoryFallback: Map<StoreName, Map<string, unknown>> | null = null;

function hasIndexedDb(): boolean {
  return typeof globalThis !== "undefined" && "indexedDB" in globalThis && globalThis.indexedDB != null;
}

function openDb(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error("no-indexeddb"));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const def of DEFINITIONS) {
        if (!db.objectStoreNames.contains(def.name)) {
          const store = db.createObjectStore(def.name, { keyPath: def.keyPath });
          for (const idx of def.indexes ?? []) {
            store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
          }
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb-open-failed"));
    request.onblocked = () => reject(new Error("indexeddb-blocked"));
  });
  return dbPromise;
}

function fallback(): Map<StoreName, Map<string, unknown>> {
  if (!memoryFallback) {
    memoryFallback = new Map();
    for (const def of DEFINITIONS) memoryFallback.set(def.name, new Map());
    // Rehydrate from localStorage so the fallback survives a reload.
    try {
      for (const def of DEFINITIONS) {
        const raw = globalThis.localStorage?.getItem(`${DB_NAME}:${def.name}`);
        if (raw) {
          const entries = JSON.parse(raw) as [string, unknown][];
          const map = memoryFallback.get(def.name)!;
          for (const [k, v] of entries) map.set(k, v);
        }
      }
    } catch {
      /* corrupt fallback storage is not worth crashing over */
    }
  }
  return memoryFallback;
}

function persistFallback(store: StoreName): void {
  try {
    const map = fallback().get(store);
    if (!map) return;
    globalThis.localStorage?.setItem(
      `${DB_NAME}:${store}`,
      JSON.stringify([...map.entries()]),
    );
  } catch {
    /* quota exceeded: the in-memory copy still works for this session */
  }
}

async function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb-request-failed"));
  });
}

export async function put<T extends Record<string, unknown>>(
  store: StoreName,
  value: T,
  keyPath = "id",
): Promise<void> {
  try {
    await tx(store, "readwrite", (s) => s.put(value));
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("indexeddb")) throw err;
    fallback().get(store)!.set(String(value[keyPath]), value);
    persistFallback(store);
  }
}

export async function get<T>(store: StoreName, key: string): Promise<T | null> {
  try {
    const value = await tx<T | undefined>(store, "readonly", (s) => s.get(key));
    return value ?? null;
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("indexeddb")) throw err;
    return (fallback().get(store)!.get(key) as T | undefined) ?? null;
  }
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  try {
    return await tx<T[]>(store, "readonly", (s) => s.getAll());
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("indexeddb")) throw err;
    return [...fallback().get(store)!.values()] as T[];
  }
}

export async function remove(store: StoreName, key: string): Promise<void> {
  try {
    await tx(store, "readwrite", (s) => s.delete(key));
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("indexeddb")) throw err;
    fallback().get(store)!.delete(key);
    persistFallback(store);
  }
}

export async function getByIndex<T>(
  store: StoreName,
  indexName: string,
  value: string,
): Promise<T[]> {
  try {
    const db = await openDb();
    return await new Promise<T[]>((resolve, reject) => {
      const transaction = db.transaction(store, "readonly");
      const request = transaction.objectStore(store).index(indexName).getAll(value);
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error("indexeddb-index-failed"));
    });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("indexeddb")) throw err;
    const keyPath = DEFINITIONS.find((d) => d.name === store)?.indexes?.find((i) => i.name === indexName)?.keyPath;
    if (!keyPath) return [];
    return ([...fallback().get(store)!.values()] as Record<string, unknown>[]).filter(
      (v) => v[keyPath] === value,
    ) as T[];
  }
}

/** True when the app is running on the localStorage fallback (worth telling the user about). */
export function usingFallbackStorage(): boolean {
  return !hasIndexedDb();
}
