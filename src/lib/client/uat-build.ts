import { allDrafts, deleteDraft, getDraft, putDraft } from "@/lib/client/drafts";
import type { WeekCatalog } from "@/lib/client/week";
import { emptyExecution } from "@/lib/domain/execution";
import { draftFromWeekModule, isUatDraftForRelease, uatDraftId } from "@/lib/domain/uat-build";
import type { Draft } from "@/lib/domain/types";

export { isUatDraftId, isUatDraftForRelease, uatDraftId, moduleSlug, draftFromWeekModule } from "@/lib/domain/uat-build";

/** UAT drafts currently stored for a release. */
export function listUatDrafts(releaseId: number): Draft[] {
  return allDrafts().filter((d) => isUatDraftForRelease(d.id, releaseId));
}

/**
 * Persists one draft per catalog module (ids `uat-{releaseId}-{slug}`), removes stale UAT drafts
 * for that release, and keeps prior execution state when the same id is reloaded (unless reset).
 */
export function materializeUatCatalog(catalog: WeekCatalog, options: { keepExecution?: boolean } = {}): Draft[] {
  const keepExecution = options.keepExecution !== false;
  const nextIds = new Set(catalog.modules.map((m) => uatDraftId(catalog.releaseId, m.module)));
  for (const existing of listUatDrafts(catalog.releaseId)) {
    if (!nextIds.has(existing.id)) {
      try {
        deleteDraft(existing.id);
      } catch {
        // already gone
      }
    }
  }

  const now = new Date().toISOString();
  const out: Draft[] = [];
  for (const m of catalog.modules) {
    const shaped = draftFromWeekModule(catalog, m, now);
    let execution = shaped.execution;
    try {
      const prev = getDraft(shaped.id);
      if (keepExecution && prev.execution) execution = prev.execution;
      shaped.createdAt = prev.createdAt;
    } catch {
      // new module draft
    }
    out.push(putDraft({ ...shaped, execution: keepExecution ? execution : emptyExecution() }));
  }
  return out;
}

/**
 * Clears local Execute / Progress marks on every UAT draft for this release so regression can start
 * fresh in the app. Does not change Spira runs or the executive report’s Spira figures.
 */
export function resetUatProgress(releaseId: number): { cleared: number } {
  const now = new Date().toISOString();
  let cleared = 0;
  for (const draft of listUatDrafts(releaseId)) {
    const hasMarks =
      !!draft.execution &&
      (draft.execution.runs.length > 0 ||
        Object.keys(draft.execution.progress).length > 0 ||
        Object.keys(draft.execution.spira).length > 0 ||
        Object.keys(draft.execution.testSets ?? {}).length > 0);
    putDraft({ ...draft, execution: emptyExecution(), updatedAt: now });
    if (hasMarks) cleared += 1;
  }
  return { cleared };
}
