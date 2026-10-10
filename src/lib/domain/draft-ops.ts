import { allCards, normalizeDecisions, preserveDecisions } from "./board";
import type { ApplyBatchInput } from "./apply-rules";
import { MAX_STEP_TEXT } from "./keywords";
import type {
  ApplyActionResult,
  Column,
  Draft,
  DraftApplyState,
  HistoryEntry,
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

/** Merges step text read from Spira; long text is cut to keep the draft small. */
export function recordStepText(draft: Draft, steps: Record<string, string>): void {
  const next = { ...(draft.stepText ?? {}) };
  for (const [testCaseId, text] of Object.entries(steps)) next[testCaseId] = text.slice(0, MAX_STEP_TEXT);
  draft.stepText = next;
}

export function recordVerification(draft: Draft, verification: VerificationResult): void {
  draft.apply.verification = verification;
  draft.status = verification.ok ? "applied" : "appliedWithErrors";
}

export function sortedEntries<T>(record: Record<string, T>): Array<[string, T]> {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
