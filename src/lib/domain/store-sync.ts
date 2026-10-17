import type { ActivityEntry } from "./types";

export const STORE_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,200}$/;

/** Kept in each browser only: who is testing on this device, and this device's preferences. */
export const LOCAL_ONLY_KEYS: ReadonlySet<string> = new Set(["tester", "defect-auto-new-case", "defect-environment", "progress-left-out", "mock-state"]);

export const ACTIVITY_KEY = "activity";
export const MAX_ACTIVITY = 1_000;

/** Every other saved item is shared through the server's store. */
export function isSyncedKey(key: string): boolean {
  return STORE_KEY_PATTERN.test(key) && !LOCAL_ONLY_KEYS.has(key);
}

const isEntry = (value: unknown): value is ActivityEntry =>
  !!value && typeof value === "object" && typeof (value as ActivityEntry).id === "string" && typeof (value as ActivityEntry).at === "string";

/** The activity log is added to from every browser, so saving it merges entries instead of replacing them. Newest first. */
export function mergeActivity(stored: unknown, incoming: unknown): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>();
  for (const list of [stored, incoming]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) if (isEntry(entry)) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ACTIVITY);
}

/** Splits items into batches of at most `maxCount` items and about `maxSize` in total; a larger item goes alone. */
export function batchBySize<T>(items: T[], sizeOf: (item: T) => number, maxSize: number, maxCount: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let total = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && (total + size > maxSize || current.length >= maxCount)) {
      batches.push(current);
      current = [];
      total = 0;
    }
    current.push(item);
    total += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface StoreEntry {
  key: string;
  updatedAt: string;
  deleted: boolean;
  size: number;
}

export interface StoreItem {
  key: string;
  value: unknown;
  updatedAt: string;
  deleted: boolean;
}

export interface StoreWritten {
  key: string;
  updatedAt: string;
  /** The server combined it with what was stored, so this browser's copy is not the latest. */
  merged: boolean;
}
