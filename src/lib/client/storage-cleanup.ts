import { isCompleted } from "@/lib/domain/board";
import { isUatDraftId } from "@/lib/domain/uat-build";
import { allDrafts, deleteDraft } from "./drafts";
import { writeItem } from "./storage";

const PREFIX = "srs:";

export interface StorageUsage {
  /** Approximate bytes used by this app in localStorage. */
  bytes: number;
  drafts: number;
  completedDrafts: number;
  uatDrafts: number;
  otherKeys: number;
}

/** Rough size of everything this app stores in localStorage. */
export function measureAppStorage(): StorageUsage {
  const storage = globalThis.localStorage;
  let bytes = 0;
  let otherKeys = 0;
  if (storage) {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const value = storage.getItem(key) ?? "";
      bytes += key.length + value.length;
      if (!key.startsWith(`${PREFIX}draft:`)) otherKeys += 1;
    }
  }
  const drafts = allDrafts();
  return {
    bytes,
    drafts: drafts.length,
    completedDrafts: drafts.filter((d) => isCompleted(d.status) && !isUatDraftId(d.id)).length,
    uatDrafts: drafts.filter((d) => isUatDraftId(d.id)).length,
    otherKeys,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deletes Completed Compare drafts only — never UAT build modules or open Drafts.
 * Spira is unchanged; frees the large board/execution payloads that fill the browser.
 */
export function deleteCompletedDrafts(): { deleted: number; freedApprox: number } {
  const before = measureAppStorage().bytes;
  let deleted = 0;
  for (const draft of allDrafts()) {
    if (!isCompleted(draft.status) || isUatDraftId(draft.id)) continue;
    deleteDraft(draft.id);
    deleted += 1;
  }
  const after = measureAppStorage().bytes;
  return { deleted, freedApprox: Math.max(0, before - after) };
}

/** Shrink the activity log (keeps the newest entries). */
export function trimActivity(keep = 100): void {
  try {
    const list = (JSON.parse(globalThis.localStorage?.getItem(`${PREFIX}activity`) ?? "[]") as unknown[]) ?? [];
    writeItem("activity", list.slice(0, keep));
  } catch {
    // ignore
  }
}
