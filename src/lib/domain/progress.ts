import { effectiveColumn, isCompleted, isExecutedColumn } from "./board";
import { MAX_DEFECT_CHECKS, MAX_DEFECT_POOL, MAX_DEFECT_SEARCH_CASES, MAX_RELATED_TERMS, MAX_SHORTLIST, mergeCandidates, rankByWording } from "./defects";
import type { BlockedConfidence, Card, Column, Draft, ProgressAnalysis } from "./types";

export {
  MAX_DEFECT_CHECKS as MAX_PROGRESS_CHECKS,
  MAX_DEFECT_POOL as MAX_PROGRESS_POOL,
  MAX_DEFECT_SEARCH_CASES as MAX_PROGRESS_SEARCH_CASES,
  MAX_RELATED_TERMS as MAX_PROGRESS_RELATED,
  MAX_SHORTLIST as MAX_PROGRESS_SHORTLIST,
  mergeCandidates as mergeProgressCandidates,
  rankByWording,
};

export const MAX_PROGRESS_TEXT = 4_000;

/** A case that can take a Passed run: still In Scope or in Defects on its board. */
export interface ProgressTarget {
  draftId: string;
  draftName: string;
  module: string;
  completed: boolean;
  testSetName: string;
  card: Card;
  column: Column;
}

/**
 * Every executable case of the given drafts (In Scope or Defects). A membership on more than one draft
 * is searched once, from a completed draft first, then the most recently updated. Cards a live apply
 * removed are left out.
 */
export function progressTargets(drafts: Draft[]): ProgressTarget[] {
  const ordered = [...drafts].sort((a, b) => Number(isCompleted(b.status)) - Number(isCompleted(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
  const removed = new Set(drafts.flatMap((d) => Object.entries(d.apply.removed).flatMap(([setId, ids]) => ids.map((id) => `${setId}:${id}`))));
  const seen = new Set<string>();
  const out: ProgressTarget[] = [];
  for (const draft of ordered) {
    const completed = isCompleted(draft.status);
    for (const set of draft.testSets) {
      for (const card of set.cards) {
        if (removed.has(card.key) || seen.has(card.key)) continue;
        const column = effectiveColumn(card, draft.decisions);
        if (!isExecutedColumn(column)) continue;
        seen.add(card.key);
        out.push({ draftId: draft.id, draftName: draft.name, module: draft.module, completed, testSetName: set.testSetName, card, column });
      }
    }
  }
  return out;
}

/** Relevance order for listing progress candidates. */
export function compareProgress(a: BlockedConfidence, b: BlockedConfidence): number {
  const rank: Record<BlockedConfidence, number> = { high: 0, medium: 1, low: 2 };
  return rank[a] - rank[b];
}

/** Reading used when Gemini could not work out the feature: the search still ends cleanly. */
export function unreadProgress(description: string): ProgressAnalysis {
  return { feature: "", related: [], area: "", summary: description.trim().slice(0, 200), question: null };
}
