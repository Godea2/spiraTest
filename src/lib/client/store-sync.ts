import { batchBySize, isSyncedKey, type StoreEntry, type StoreItem, type StoreWritten } from "@/lib/domain/store-sync";
import { api, errorMessage } from "./api";
import { keysWithPrefix, onLocalChange, readRaw, removeRaw, StorageFullError, writeRaw } from "./storage";

/**
 * Keeps this browser's saved data in step with the shared store (Supabase, through /api/store).
 * The app keeps reading and writing browser storage as before; every change is queued and saved to the
 * server shortly after, and opening the app (or coming back to it) loads what others changed.
 * The newest save of an item wins, except the activity log, which the server merges.
 */

const META_KEY = "srs-sync:meta";
const PENDING_KEY = "srs-sync:pending";
const MAX_READ = 2_000_000;
const MAX_WRITE = 3_000_000;
const MAX_ITEMS = 50;
const PULL_EVERY_MS = 30_000;
const RETRY_MS = [5_000, 15_000, 60_000];
export const SYNCED_EVENT = "srs:synced";

export type SyncMode = "unknown" | "local" | "cloud";

export interface SyncState {
  /** cloud: saved to Supabase; local: shared storage is not set up, so data stays in this browser. */
  mode: SyncMode;
  busy: boolean;
  error: string | null;
  savedAt: string | null;
}

/** Before the first answer from the server, and while rendering on the server. */
export const INITIAL_SYNC: SyncState = { mode: "unknown", busy: false, error: null, savedAt: null };

type StatusResponse = { configured: false } | { configured: true; entries: StoreEntry[] };

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // bookkeeping only: at worst an item is sent or read again
  }
}

const parse = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export function createStoreSync(options: { flushDelayMs?: number } = {}) {
  const flushDelay = options.flushDelayMs ?? 800;
  let state = INITIAL_SYNC;
  const listeners = new Set<() => void>();
  let chain: Promise<unknown> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let lastPull = 0;

  const set = (patch: Partial<SyncState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const meta = () => readJson<Record<string, string>>(META_KEY, {});
  const pending = () => new Set(readJson<string[]>(PENDING_KEY, []));
  const savePending = (keys: Set<string>) => writeJson(PENDING_KEY, [...keys]);

  /** One pull or push at a time, in order. */
  const serial = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const failed = (error: unknown) => {
    set({ busy: false, error: errorMessage(error) });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void sync(), RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
    failures += 1;
  };

  function markPending(key: string): void {
    if (!isSyncedKey(key) || state.mode === "local") return;
    const keys = pending();
    keys.add(key);
    savePending(keys);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flush(), flushDelay);
  }

  const flush = () =>
    serial(async () => {
      if (state.mode !== "cloud") return;
      const keys = [...pending()];
      if (keys.length === 0) return;
      set({ busy: true });
      try {
        const sent = keys.map((key) => ({ key, raw: readRaw(key) }));
        for (const batch of batchBySize(sent, (s) => (s.raw?.length ?? 0) + s.key.length, MAX_WRITE, MAX_ITEMS)) {
          const { items } = await api<{ items: StoreWritten[] }>("/api/store", {
            method: "PUT",
            body: { items: batch.map((s) => ({ key: s.key, value: parse(s.raw) })) },
          });
          const m = meta();
          const left = pending();
          for (const written of items) {
            // Changed again while saving: keep it queued for the next save.
            if (readRaw(written.key) !== batch.find((s) => s.key === written.key)?.raw) continue;
            left.delete(written.key);
            if (written.merged) delete m[written.key];
            else m[written.key] = written.updatedAt;
          }
          writeJson(META_KEY, m);
          savePending(left);
        }
        failures = 0;
        set({ busy: false, error: null, savedAt: new Date().toISOString() });
      } catch (error) {
        failed(error);
      }
    });

  const pull = () =>
    serial(async () => {
      set({ busy: true });
      try {
        const status = await api<StatusResponse>("/api/store");
        if (!status.configured) {
          savePending(new Set());
          set({ mode: "local", busy: false, error: null });
          return;
        }
        set({ mode: "cloud" });
        const m = meta();
        const queued = pending();
        const remote = new Map(status.entries.map((e) => [e.key, e]));
        // Saved here but never in the shared store (for example from before it was set up): send it.
        for (const key of keysWithPrefix("")) if (isSyncedKey(key) && !remote.has(key)) queued.add(key);
        savePending(queued);

        const changed: string[] = [];
        let full = false;
        for (const e of status.entries) {
          if (!e.deleted || queued.has(e.key) || m[e.key] === e.updatedAt) continue;
          if (readRaw(e.key) !== null) {
            removeRaw(e.key);
            changed.push(e.key);
          }
          m[e.key] = e.updatedAt;
        }
        const wanted = status.entries.filter((e) => !e.deleted && !queued.has(e.key) && (m[e.key] !== e.updatedAt || readRaw(e.key) === null));
        for (const batch of batchBySize(wanted, (e) => e.size + e.key.length, MAX_READ, MAX_ITEMS)) {
          const { items } = await api<{ items: StoreItem[] }>("/api/store/read", { method: "POST", body: { keys: batch.map((e) => e.key) } });
          const now = pending();
          for (const item of items) {
            if (now.has(item.key)) continue;
            try {
              if (item.deleted) removeRaw(item.key);
              else writeRaw(item.key, JSON.stringify(item.value));
              m[item.key] = item.updatedAt;
              changed.push(item.key);
            } catch (error) {
              if (!(error instanceof StorageFullError)) throw error;
              full = true;
            }
          }
          writeJson(META_KEY, m);
        }
        writeJson(META_KEY, m);
        lastPull = Date.now();
        failures = 0;
        set({ busy: false, error: full ? "This browser's storage is full, so some shared items could not be loaded here." : null });
        if (changed.length > 0 && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SYNCED_EVENT, { detail: changed }));
      } catch (error) {
        failed(error);
      }
    });

  /** Loads what changed elsewhere, then saves what changed here. Never rejects. */
  const sync = async () => {
    await pull();
    await flush();
  };

  return {
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    markPending,
    flush,
    pull,
    sync,
    pullIfStale: () => (Date.now() - lastPull > PULL_EVERY_MS ? sync() : Promise.resolve()),
  };
}

export const storeSync = createStoreSync();

let started: Promise<void> | null = null;

/** Starts syncing this browser (once); resolves when the first load from the shared store has finished or failed. */
export function startStoreSync(): Promise<void> {
  if (!started) {
    onLocalChange(storeSync.markPending);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void storeSync.pullIfStale();
      else void storeSync.flush();
    });
    window.addEventListener("online", () => void storeSync.sync());
    started = storeSync.sync();
  }
  return started;
}
