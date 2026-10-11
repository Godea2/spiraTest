import "server-only";
import { SIGN_OFF_COLUMN, validateApplyBatch, type ApplyBatchInput } from "@/lib/domain/apply-rules";
import { allCards, diffMembership, intendedMembership, normalizeDecisions } from "@/lib/domain/board";
import { reconcileTestSet as matchTestSet } from "@/lib/domain/matching";
import type {
  ApplyAction,
  ApplyActionResult,
  Column,
  Platform,
  PreflightResult,
  SignOffResult,
  SignOffStatus,
  TestSetComparison,
  VerificationResult,
  WorkbookRow,
  WorkflowContext,
} from "@/lib/domain/types";
import { sealComparison, sealPreflight, verifiedPreflight, verifyComparisons } from "./seal";
import {
  deleteRecordedTestRun,
  EXECUTION_STATUS,
  getMembership,
  getTestSet,
  getTestSetCases,
  recordTestRun,
  removeFromTestSet,
  RUNNER_NAME,
  SpiraError,
  type SpiraSetCase,
} from "./spira";

// Stateless: every request carries the board it acts on. Anything that decides what
// may be removed is checked against the server's own signatures before it is used.

/** Parallel Spira removals per batch; keeps a 25-case batch well inside the function time limit. */
const REMOVE_CONCURRENCY = 5;

export interface TestSetRef {
  testSetId: number;
  testSetName: string;
  platform: Platform;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Spira request failed.");

/** Verified comparisons plus decisions reduced to genuine overrides of those cards. */
function verifiedBoard(ctx: WorkflowContext, testSets: TestSetComparison[], decisions: Record<string, Column>) {
  const sets = verifyComparisons(ctx, testSets);
  return { sets, decisions: normalizeDecisions(allCards(sets), decisions) };
}

export async function reconcileTestSet(input: {
  context: WorkflowContext;
  testSet: TestSetRef;
  rows: WorkbookRow[];
}): Promise<{ comparison: TestSetComparison }> {
  const { context: ctx, testSet } = input;
  const [spiraSet, cases] = await Promise.all([
    getTestSet(ctx.projectId, testSet.testSetId),
    getTestSetCases(ctx.projectId, testSet.testSetId),
  ]);
  const output = matchTestSet(testSet.testSetId, input.rows, cases);
  const comparison = sealComparison(ctx, {
    testSetId: testSet.testSetId,
    testSetName: spiraSet.name || testSet.testSetName,
    platform: testSet.platform,
    comparedAt: new Date().toISOString(),
    cards: output.cards,
    missingFromSpira: output.missingFromSpira,
    baselineMembership: output.membership,
  });
  return { comparison };
}

/** Reads every set's current membership and checks it still matches the reviewed baseline. */
export async function runPreflight(input: {
  context: WorkflowContext;
  testSets: TestSetComparison[];
  decisions: Record<string, Column>;
  removed: Record<string, number[]>;
}): Promise<{ preflight: PreflightResult }> {
  const ctx = input.context;
  const { sets: verified, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  const sets = await Promise.all(
    verified.map(async (set) => {
      const alreadyRemoved = new Set(input.removed[String(set.testSetId)] ?? []);
      const expected = set.baselineMembership.filter((id) => !alreadyRemoved.has(id));
      try {
        const current = await getMembership(ctx.projectId, set.testSetId);
        const diff = diffMembership(expected, [...current.keys()]);
        return { testSetId: set.testSetId, ok: diff.unexpected.length === 0 && diff.missing.length === 0, ...diff };
      } catch (error) {
        return { testSetId: set.testSetId, ok: false, unexpected: [], missing: [], error: errorText(error) };
      }
    }),
  );
  const preflight = sealPreflight(
    ctx,
    { at: new Date().toISOString(), ok: sets.length > 0 && sets.every((s) => s.ok), sets },
    verified,
    decisions,
  );
  return { preflight };
}

async function inPool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Remove-only, batched apply against a verified board. Membership is re-read from Spira
 * first, and a case is only removed if that membership still points at the same test case.
 * Dry runs make no changes.
 */
export async function applyBatch(input: {
  context: WorkflowContext;
  testSets: TestSetComparison[];
  decisions: Record<string, Column>;
  removed: Record<string, number[]>;
  preflight: PreflightResult | null;
  batch: ApplyBatchInput;
}): Promise<{ results: ApplyActionResult[] }> {
  const ctx = input.context;
  const { batch } = input;
  const { sets, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  validateApplyBatch(
    { module: ctx.module, testSets: sets, decisions, preflight: verifiedPreflight(ctx, input.preflight, sets, decisions) },
    batch,
  );

  const alreadyRemoved = new Set(input.removed[String(batch.testSetId)] ?? []);
  const result = (action: ApplyAction, status: ApplyActionResult["status"], message: string | null = null) => ({
    ...action,
    status,
    message,
  });

  let current: Map<number, number>;
  try {
    current = await getMembership(ctx.projectId, batch.testSetId);
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    return { results: batch.actions.map((action) => result(action, "failed", error.message)) };
  }

  const results = await inPool(batch.actions, REMOVE_CONCURRENCY, async (action): Promise<ApplyActionResult> => {
    if (!batch.dryRun && alreadyRemoved.has(action.testSetTestCaseId)) {
      return result(action, "skipped", "Already removed in an earlier run.");
    }
    const testCaseId = current.get(action.testSetTestCaseId);
    if (testCaseId === undefined) return result(action, "skipped", "No longer in this test set in Spira.");
    if (testCaseId !== action.testCaseId) {
      return result(action, "failed", `This membership now points at test case ${testCaseId}. Recompare before applying.`);
    }
    if (batch.dryRun) return result(action, "wouldRemove");
    try {
      await removeFromTestSet(ctx.projectId, batch.testSetId, action.testSetTestCaseId);
      return result(action, "removed");
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
      return result(action, "failed", error.message);
    }
  });
  return { results };
}

/** Reads membership again after live apply and compares it with the intended membership. */
export async function verifyApply(input: {
  context: WorkflowContext;
  testSets: TestSetComparison[];
  decisions: Record<string, Column>;
}): Promise<{ verification: VerificationResult }> {
  const ctx = input.context;
  const { sets: verified, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  const sets = await Promise.all(
    verified.map(async (set) => {
      const intended = intendedMembership(set, decisions);
      try {
        const current = await getMembership(ctx.projectId, set.testSetId);
        const diff = diffMembership(intended, [...current.keys()]);
        return {
          testSetId: set.testSetId,
          ok: diff.unexpected.length === 0 && diff.missing.length === 0,
          stillPresent: diff.unexpected,
          unexpectedlyRemoved: diff.missing,
        };
      } catch (error) {
        return { testSetId: set.testSetId, ok: false, stillPresent: [], unexpectedlyRemoved: [], error: errorText(error) };
      }
    }),
  );
  return { verification: { at: new Date().toISOString(), ok: sets.length > 0 && sets.every((s) => s.ok), sets } };
}

export interface SignOffBatchInput extends ApplyBatchInput {
  status: SignOffStatus;
}

/**
 * Records a Blocked or Passed automated test run for each card, against a verified board.
 * The test set is re-read first: a case is only recorded if it is still in the set, still
 * the same test case, and has no result yet (Not Run). Dry runs make no changes.
 */
export async function signOffBatch(input: {
  context: WorkflowContext;
  testSets: TestSetComparison[];
  decisions: Record<string, Column>;
  removed: Record<string, number[]>;
  preflight: PreflightResult | null;
  draftName: string;
  notes?: Record<string, string>;
  batch: SignOffBatchInput;
}): Promise<{ results: SignOffResult[] }> {
  const ctx = input.context;
  const { batch } = input;
  const { sets, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  validateApplyBatch(
    { module: ctx.module, testSets: sets, decisions, preflight: verifiedPreflight(ctx, input.preflight, sets, decisions) },
    batch,
    Date.now(),
    SIGN_OFF_COLUMN[batch.status],
  );

  const result = (
    action: ApplyAction,
    outcome: SignOffResult["result"],
    message: string | null = null,
    testRunId: number | null = null,
  ): SignOffResult => ({ ...action, testSetId: batch.testSetId, status: batch.status, result: outcome, testRunId, message });

  let cases: Map<number, SpiraSetCase>;
  let releaseId: number | null;
  try {
    const [spiraSet, list] = await Promise.all([
      getTestSet(ctx.projectId, batch.testSetId),
      getTestSetCases(ctx.projectId, batch.testSetId),
    ]);
    cases = new Map(list.map((c) => [c.testSetTestCaseId, c]));
    releaseId = ctx.releaseId ?? spiraSet.releaseId;
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    return { results: batch.actions.map((action) => result(action, "failed", error.message)) };
  }

  const blocked = batch.status === "blocked";
  const results = await inPool(batch.actions, REMOVE_CONCURRENCY, async (action): Promise<SignOffResult> => {
    const current = cases.get(action.testSetTestCaseId);
    if (!current) return result(action, "skipped", "No longer in this test set in Spira.");
    if (current.testCaseId !== action.testCaseId) {
      return result(action, "failed", `This membership now points at test case ${current.testCaseId}. Recompare first.`);
    }
    if (current.executionStatusId !== null && current.executionStatusId !== EXECUTION_STATUS.notRun) {
      return result(action, "skipped", `Already has a result in Spira (${current.executionStatus}).`);
    }
    if (batch.dryRun) return result(action, "wouldRecord");
    const note = input.notes?.[String(action.testSetTestCaseId)]?.trim();
    try {
      const testRunId = await recordTestRun(ctx.projectId, {
        testCaseId: action.testCaseId,
        testSetId: batch.testSetId,
        testSetTestCaseId: action.testSetTestCaseId,
        releaseId,
        executionStatusId: blocked ? EXECUTION_STATUS.blocked : EXECUTION_STATUS.passed,
        testName: current.name,
        message: blocked ? `Blocked: feature not implemented${note ? ` (${note})` : ""}` : "Passed: signed off with the approved scope",
        details: [
          `Recorded by ${RUNNER_NAME} when the scope for module ${ctx.module} was approved (draft "${input.draftName}").`,
          note ? `Not-implemented features in the test scenario: ${note}` : null,
          "No test steps were executed by this tool.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      return result(action, "recorded", null, testRunId);
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
      return result(action, "failed", error.message);
    }
  });
  return { results };
}

/** Deletes test runs this app recorded. Each run is checked to be ours before it is deleted. */
export async function undoSignOff(input: {
  context: WorkflowContext;
  runs: { testRunId: number; testCaseId: number }[];
}): Promise<{ results: { testRunId: number; ok: boolean; message: string | null }[] }> {
  const ctx = input.context;
  const results = await inPool(input.runs, REMOVE_CONCURRENCY, async (run) => {
    try {
      await deleteRecordedTestRun(ctx.projectId, run.testRunId, run.testCaseId);
      return { testRunId: run.testRunId, ok: true, message: null };
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
      if (error.upstream === 404) return { testRunId: run.testRunId, ok: true, message: "Already deleted in Spira." };
      return { testRunId: run.testRunId, ok: false, message: error.message };
    }
  });
  return { results };
}
