import { allCards, cardKey, moveCards, normalizeDecisions, preserveDecisions, removalActions } from "./board";
import type { ApplyBatchInput } from "./apply-rules";
import { emptyExecution, EXECUTION_STATUS, EXECUTION_STATUS_NAMES, STATUS_LABEL } from "./execution";
import type {
  ApplyActionResult,
  BlockedAssessment,
  CardChange,
  Column,
  Draft,
  DraftApplyState,
  ExecutionProgress,
  ExecutionResult,
  ExecutionRun,
  HistoryEntry,
  TestSetExecutionStatus,
  TestSetUpkeep,
  PreflightResult,
  SignOffAction,
  SignOffResult,
  TestSetComparison,
  VerificationResult,
} from "./types";

// Each function mutates the draft it is given; callers pass a copy.

export function emptyApplyState(): DraftApplyState {
  return {
    preflight: null,
    removed: {},
    failed: {},
    verification: null,
    lastLiveRunAt: null,
    lastDryRunAt: null,
    signOffRuns: [],
    signOffFailed: [],
  };
}

export function recordComparison(draft: Draft, comparison: TestSetComparison): void {
  const isRecompare = draft.testSets.some((set) => set.testSetId === comparison.testSetId);
  draft.testSets = [...draft.testSets.filter((set) => set.testSetId !== comparison.testSetId), comparison].sort(
    (a, b) => draft.testSetIds.indexOf(a.testSetId) - draft.testSetIds.indexOf(b.testSetId),
  );
  delete draft.compareErrors[String(comparison.testSetId)];
  draft.decisions = preserveDecisions(draft.decisions, allCards(draft.testSets));
  draft.apply.preflight = null;
  if (isRecompare) {
    draft.history.push({ at: comparison.comparedAt, label: `Recompared ${comparison.testSetName}`, changes: [] });
  }
}

export function recordCompareError(draft: Draft, testSetId: number, message: string): void {
  draft.compareErrors[String(testSetId)] = message;
}

/** Saves board edits. Any change to decisions invalidates the last membership check. */
export function recordBoardEdits(
  draft: Draft,
  edits: { decisions?: Record<string, Column>; history?: HistoryEntry[] },
): void {
  if (edits.decisions) {
    const next = normalizeDecisions(allCards(draft.testSets), edits.decisions);
    if (JSON.stringify(sortedEntries(next)) !== JSON.stringify(sortedEntries(draft.decisions))) {
      draft.apply.preflight = null;
    }
    draft.decisions = next;
  }
  if (edits.history) draft.history = edits.history;
}

export function recordPreflight(draft: Draft, preflight: PreflightResult): void {
  draft.apply.preflight = preflight;
}

/**
 * Takes Spira's word for removals: Out of Scope memberships that a membership check found already gone
 * count as removed, so they are not sent again and no longer read as a change in Spira. Anything else
 * that differs is left for a recompare. Returns how many were taken over.
 */
export function adoptSpiraRemovals(draft: Draft, preflight: PreflightResult): number {
  let adopted = 0;
  for (const result of preflight.sets) {
    const set = draft.testSets.find((s) => s.testSetId === result.testSetId);
    if (!set || result.error) continue;
    const removing = new Set(removalActions(set, draft.decisions).map((a) => a.testSetTestCaseId));
    const gone = result.missing.filter((id) => removing.has(id));
    if (gone.length === 0) continue;
    const key = String(set.testSetId);
    const removed = new Set(draft.apply.removed[key] ?? []);
    const failed = new Set(draft.apply.failed[key] ?? []);
    for (const id of gone) {
      if (!removed.has(id)) adopted += 1;
      removed.add(id);
      failed.delete(id);
    }
    draft.apply.removed[key] = [...removed].sort((a, b) => a - b);
    draft.apply.failed[key] = [...failed].sort((a, b) => a - b);
  }
  if (adopted) draft.apply.preflight = null;
  return adopted;
}

export function recordApplyResults(
  draft: Draft,
  input: Pick<ApplyBatchInput, "testSetId" | "dryRun">,
  results: ApplyActionResult[],
  now = new Date(),
): void {
  const at = now.toISOString();
  if (input.dryRun) {
    draft.apply.lastDryRunAt = at;
    return;
  }
  const key = String(input.testSetId);
  draft.apply.lastLiveRunAt = at;
  const removed = new Set(draft.apply.removed[key] ?? []);
  const failed = new Set(draft.apply.failed[key] ?? []);
  for (const result of results) {
    if (result.status === "removed" || result.status === "skipped") {
      removed.add(result.testSetTestCaseId);
      failed.delete(result.testSetTestCaseId);
    } else if (result.status === "failed") {
      failed.add(result.testSetTestCaseId);
    }
  }
  draft.apply.removed[key] = [...removed].sort((a, b) => a - b);
  draft.apply.failed[key] = [...failed].sort((a, b) => a - b);
}

const actionKey = (a: SignOffAction) => `${a.testSetId}:${a.testSetTestCaseId}:${a.status}`;

/** Keeps the IDs of recorded runs (for undo) and the failures (for retry). Dry runs change nothing. */
export function recordSignOffResults(draft: Draft, dryRun: boolean, results: SignOffResult[], now = new Date()): void {
  if (dryRun) return;
  const at = now.toISOString();
  const runs = [...(draft.apply.signOffRuns ?? [])];
  const failed = new Map((draft.apply.signOffFailed ?? []).map((a) => [actionKey(a), a]));
  for (const r of results) {
    const action: SignOffAction = { testSetId: r.testSetId, testCaseId: r.testCaseId, testSetTestCaseId: r.testSetTestCaseId, status: r.status };
    if (r.result === "failed") {
      failed.set(actionKey(action), action);
      continue;
    }
    failed.delete(actionKey(action));
    if (r.result === "recorded" && r.testRunId !== null) runs.push({ ...action, testRunId: r.testRunId, at });
  }
  draft.apply.signOffRuns = runs;
  draft.apply.signOffFailed = [...failed.values()];
}

export function recordSignOffUndo(draft: Draft, deletedRunIds: number[]): void {
  const deleted = new Set(deletedRunIds);
  draft.apply.signOffRuns = (draft.apply.signOffRuns ?? []).filter((run) => !deleted.has(run.testRunId));
}

/** Stores blocked/not-blocked verdicts and marks when Filter ran. */
export function recordBlockedReview(draft: Draft, assessments: Record<string, BlockedAssessment>, at: string): void {
  draft.blockedReview = { ...(draft.blockedReview ?? {}), ...assessments };
  draft.keywordsFilteredAt = at;
}

export function recordVerification(draft: Draft, verification: VerificationResult): void {
  draft.apply.verification = verification;
  draft.status = verification.ok ? "applied" : "appliedWithErrors";
}

/** Keeps the latest execution status read from Spira for every membership on the board. */
export function recordExecutionStatus(draft: Draft, sets: TestSetExecutionStatus[], at: string): void {
  const execution = draft.execution ?? emptyExecution();
  for (const set of sets) {
    if (set.error) continue;
    for (const c of set.cases) {
      execution.spira[cardKey(set.testSetId, c.testSetTestCaseId)] = { statusId: c.statusId, status: c.status };
    }
    if (set.testSetStatus) execution.testSets = { ...execution.testSets, [set.testSetId]: set.testSetStatus };
  }
  execution.checkedAt = at;
  draft.execution = execution;
}

/** The test set status the server left in Spira after recording runs; it now matches the test set's cases. */
export function recordTestSetUpkeep(draft: Draft, upkeep: TestSetUpkeep): void {
  if (upkeep.error || upkeep.statusName === null) return;
  const execution = draft.execution ?? emptyExecution();
  execution.testSets = { ...execution.testSets, [upkeep.testSetId]: { statusId: upkeep.statusId, name: upkeep.statusName, expectedId: null } };
  draft.execution = execution;
}

/** Saves, or with null clears, the marks a tester made on a case that is not sent yet. */
export function saveExecutionProgress(draft: Draft, key: string, progress: ExecutionProgress | null): void {
  const execution = draft.execution ?? emptyExecution();
  if (progress) execution.progress[key] = progress;
  else delete execution.progress[key];
  draft.execution = execution;
}

/**
 * Keeps each recorded run (for undo), takes its result as the case's status in Spira and clears the
 * case's unsent marks. Failed and skipped cases keep their marks so they can be sent again.
 */
export function recordExecutionResults(
  draft: Draft,
  results: ExecutionResult[],
  sent: Array<Pick<ExecutionRun, "testSetTestCaseId" | "comment">>,
  tester: string,
  now = new Date(),
): void {
  const execution = draft.execution ?? emptyExecution();
  const at = now.toISOString();
  for (const r of results) {
    if (r.result !== "recorded" || r.testRunId === null) continue;
    const key = cardKey(r.testSetId, r.testSetTestCaseId);
    execution.runs.push({
      testSetId: r.testSetId,
      testCaseId: r.testCaseId,
      testSetTestCaseId: r.testSetTestCaseId,
      status: r.status,
      testRunId: r.testRunId,
      at,
      tester,
      comment: sent.find((s) => s.testSetTestCaseId === r.testSetTestCaseId)?.comment ?? "",
    });
    const statusId = r.spiraStatusId !== undefined ? r.spiraStatusId : EXECUTION_STATUS[r.status];
    execution.spira[key] = { statusId, status: statusId === null ? "Not Run" : (EXECUTION_STATUS_NAMES[statusId] ?? STATUS_LABEL[r.status]) };
    delete execution.progress[key];
  }
  draft.execution = execution;
}

/** Forgets runs deleted from Spira. Their cases' statuses are read again afterwards. */
export function recordExecutionUndo(draft: Draft, deletedRunIds: number[]): void {
  if (!draft.execution) return;
  const deleted = new Set(deletedRunIds);
  draft.execution.runs = draft.execution.runs.filter((run) => !deleted.has(run.testRunId));
}

/**
 * Moves cards for a defect (to Defects, or back where they were on undo) as one step in the board's
 * history. Like any board edit it clears the last membership check. Returns the moves made.
 */
export function recordDefectMoves(draft: Draft, moves: Array<{ key: string; to: Column }>, label: string, at: string): CardChange[] {
  const cards = allCards(draft.testSets);
  let decisions = draft.decisions;
  const changes: CardChange[] = [];
  for (const to of new Set(moves.map((m) => m.to))) {
    const out = moveCards(cards, decisions, moves.filter((m) => m.to === to).map((m) => m.key), to);
    decisions = out.decisions;
    changes.push(...out.changes);
  }
  if (changes.length > 0) recordBoardEdits(draft, { decisions, history: [...draft.history, { at, label, changes }] });
  return changes;
}

export function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
