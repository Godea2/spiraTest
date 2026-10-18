import { allDrafts, deleteDraft, getDraft, putDraft } from "@/lib/client/drafts";
import type { WeekCatalog } from "@/lib/client/week";
import { draftFromWeekModule, isUatDraftForRelease, uatDraftId } from "@/lib/domain/uat-build";
import type { Draft } from "@/lib/domain/types";

export { isUatDraftId, isUatDraftForRelease, uatDraftId, moduleSlug, draftFromWeekModule } from "@/lib/domain/uat-build";

/** UAT drafts currently stored for a release. */
export function listUatDrafts(releaseId: number): Draft[] {
  return allDrafts().filter((d) => isUatDraftForRelease(d.id, releaseId));
}

/**
 * Persists one draft per catalog module (ids `uat-{releaseId}-{slug}`), removes stale UAT drafts
 * for that release, and keeps prior execution state when the same id is reloaded.
 */
export function materializeUatCatalog(catalog: WeekCatalog): Draft[] {
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
      if (prev.execution) execution = prev.execution;
      shaped.createdAt = prev.createdAt;
    } catch {
      // new module draft
    }
    out.push(putDraft({ ...shaped, execution }));
  }
  return out;
}
