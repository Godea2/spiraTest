import type { ActivityEntry } from "@/lib/domain/types";
import { readItem, writeItem } from "./storage";

const KEY = "activity";
const MAX_ENTRIES = 1_000;

export function listActivity(): ActivityEntry[] {
  return readItem<ActivityEntry[]>(KEY) ?? [];
}

/** Newest first. Logging never blocks the action it records, so storage errors are ignored. */
export function logActivity(entry: Omit<ActivityEntry, "id" | "at" | "draftId" | "module" | "details"> & Partial<ActivityEntry>): void {
  const full: ActivityEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    draftId: null,
    module: null,
    details: null,
    ...entry,
  };
  try {
    writeItem(KEY, [full, ...listActivity()].slice(0, MAX_ENTRIES));
  } catch {
    // Activity is a convenience log; a full store must not stop a comparison or apply.
  }
}
