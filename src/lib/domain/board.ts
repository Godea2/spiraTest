import type {
  ApplyAction,
  Card,
  CardChange,
  Column,
  ColumnCounts,
  Draft,
  DraftStatus,
  DraftSummary,
  TestSetComparison,
} from "./types";

export const MAX_APPLY_BATCH = 10;

export function cardKey(testSetId: number, testSetTestCaseId: number): string {
  return `${testSetId}:${testSetTestCaseId}`;
}

export function effectiveColumn(card: Card, decisions: Record<string, Column>): Column {
  return decisions[card.key] ?? card.suggestion;
}

/** Columns whose cases are executed: In Scope, and In Scope cases with a defect. */
export const EXECUTED_COLUMNS: ReadonlySet<Column> = new Set<Column>(["inScope", "defects"]);

export const isExecutedColumn = (column: Column): boolean => EXECUTED_COLUMNS.has(column);

export function allCards(testSets: TestSetComparison[]): Card[] {
  return testSets.flatMap((set) => set.cards);
}

export function countColumns(cards: Card[], decisions: Record<string, Column>): ColumnCounts {
  const counts: ColumnCounts = { inScope: 0, defects: 0, blocked: 0, outOfScope: 0, needsReview: 0, total: 0 };
  for (const card of cards) {
    counts[effectiveColumn(card, decisions)] += 1;
    counts.total += 1;
  }
  return counts;
}

/** Drops decisions that equal the suggestion so only genuine overrides are stored. */
export function normalizeDecisions(
  cards: Card[],
  decisions: Record<string, Column>,
): Record<string, Column> {
  const byKey = new Map(cards.map((card) => [card.key, card]));
  const next: Record<string, Column> = {};
  for (const [key, column] of Object.entries(decisions)) {
    const card = byKey.get(key);
    if (card && card.suggestion !== column) next[key] = column;
  }
  return next;
}

/**
 * Applies a move and returns the resulting decisions plus the effective changes.
 * Cards already in the target column produce no change.
 */
export function moveCards(
  cards: Card[],
  decisions: Record<string, Column>,
  keys: string[],
  to: Column,
): { decisions: Record<string, Column>; changes: CardChange[] } {
  const byKey = new Map(cards.map((card) => [card.key, card]));
  const next = { ...decisions };
  const changes: CardChange[] = [];
  for (const key of new Set(keys)) {
    const card = byKey.get(key);
    if (!card) continue;
    const from = effectiveColumn(card, next);
    if (from === to) continue;
    if (card.suggestion === to) delete next[key];
    else next[key] = to;
    changes.push({ key, from, to });
  }
  return { decisions: next, changes };
}

/** Reverses (or replays) a set of changes. */
export function applyChanges(
  cards: Card[],
  decisions: Record<string, Column>,
  changes: CardChange[],
  direction: "undo" | "redo",
): Record<string, Column> {
  const byKey = new Map(cards.map((card) => [card.key, card]));
  const next = { ...decisions };
  for (const change of changes) {
    const card = byKey.get(change.key);
    if (!card) continue;
    const target = direction === "undo" ? change.from : change.to;
    if (card.suggestion === target) delete next[change.key];
    else next[change.key] = target;
  }
  return next;
}

/** Keeps manual decisions only for cards that still exist after a recompare. */
export function preserveDecisions(
  previous: Record<string, Column>,
  cards: Card[],
): Record<string, Column> {
  return normalizeDecisions(cards, previous);
}

export function executedMovingOut(
  cards: Card[],
  decisions: Record<string, Column>,
  keys: string[],
  to: Column,
): Card[] {
  if (to !== "outOfScope") return [];
  const wanted = new Set(keys);
  return cards.filter(
    (card) =>
      wanted.has(card.key) && card.executed && effectiveColumn(card, decisions) !== "outOfScope",
  );
}

export function removalActions(
  set: TestSetComparison,
  decisions: Record<string, Column>,
): ApplyAction[] {
  return set.cards
    .filter((card) => effectiveColumn(card, decisions) === "outOfScope")
    .map((card) => ({ testCaseId: card.testCaseId, testSetTestCaseId: card.testSetTestCaseId }));
}

/** Membership the test set should have once every Out of Scope card is removed. */
export function intendedMembership(
  set: TestSetComparison,
  decisions: Record<string, Column>,
): number[] {
  const removing = new Set(removalActions(set, decisions).map((a) => a.testSetTestCaseId));
  return set.baselineMembership.filter((id) => !removing.has(id)).sort((a, b) => a - b);
}

export function diffMembership(
  expected: number[],
  actual: number[],
): { unexpected: number[]; missing: number[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    unexpected: actual.filter((id) => !expectedSet.has(id)).sort((a, b) => a - b),
    missing: expected.filter((id) => !actualSet.has(id)).sort((a, b) => a - b),
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("Chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function isComparisonComplete(draft: Pick<Draft, "testSetIds" | "testSets">): boolean {
  const compared = new Set(draft.testSets.map((set) => set.testSetId));
  return draft.testSetIds.length > 0 && draft.testSetIds.every((id) => compared.has(id));
}

/**
 * A draft is completed once Spira is verified to match the reviewed board: after a live apply, or
 * straight away when the board has nothing to remove.
 */
export const isCompleted = (status: DraftStatus): boolean => status === "applied";

/** Out of Scope memberships a live apply still has to remove (those already removed are left out). */
export function pendingRemovals(draft: Pick<Draft, "testSets" | "decisions" | "apply">): number {
  return draft.testSets.reduce((n, set) => {
    const removed = new Set(draft.apply.removed[String(set.testSetId)] ?? []);
    return n + removalActions(set, draft.decisions).filter((a) => !removed.has(a.testSetTestCaseId)).length;
  }, 0);
}

/**
 * Why a draft still needs the review before it can complete, or null when there is nothing left to
 * change in Spira: every test set compared, nothing in Needs Review and nothing to remove. Such a draft
 * only has to be checked against Spira (read only) to complete.
 */
export function completionBlocker(draft: Draft): string | null {
  if (isCompleted(draft.status)) return "Already completed.";
  if (!isComparisonComplete(draft)) return "Every test set must be compared first.";
  const review = countColumns(allCards(draft.testSets), draft.decisions).needsReview;
  if (review > 0) return `${review} card${review === 1 ? " is" : "s are"} in Needs Review.`;
  const pending = pendingRemovals(draft);
  if (pending > 0) return `${pending} Out of Scope case${pending === 1 ? "" : "s"} to remove with a live apply.`;
  return null;
}

/** Whether a completed draft's board now asks for changes in Spira again (cards to remove or to review). */
export function needsReopening(draft: Draft): boolean {
  return isCompleted(draft.status) && (pendingRemovals(draft) > 0 || countColumns(allCards(draft.testSets), draft.decisions).needsReview > 0);
}

export function summarizeDraft(draft: Draft): DraftSummary {
  const cards = allCards(draft.testSets);
  return {
    id: draft.id,
    name: draft.name,
    module: draft.module,
    status: draft.status,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    completedAt: isCompleted(draft.status) ? (draft.apply.verification?.at ?? draft.apply.lastLiveRunAt ?? draft.updatedAt) : null,
    testSetIds: draft.testSetIds,
    comparedTestSetIds: draft.testSets.map((set) => set.testSetId),
    complete: isComparisonComplete(draft),
    counts: countColumns(cards, draft.decisions),
    missingFromSpira: draft.testSets.reduce((sum, set) => sum + set.missingFromSpira.length, 0),
    manualDecisions: Object.keys(draft.decisions).length,
    readyToComplete: completionBlocker(draft) === null,
    completedWithoutChanges: isCompleted(draft.status) && !!draft.apply.completedWithoutChanges && !draft.apply.lastLiveRunAt,
  };
}
