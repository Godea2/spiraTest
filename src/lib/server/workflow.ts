import "server-only";
import { validateApplyBatch, type ApplyBatchInput } from "@/lib/domain/apply-rules";
import { allCards, diffMembership, intendedMembership, normalizeDecisions } from "@/lib/domain/board";
import { reconcileTestSet as matchTestSet } from "@/lib/domain/matching";
import type {
  ApplyAction,
  ApplyActionResult,
  Column,
  Platform,
  PreflightResult,
  TestSetComparison,
  VerificationResult,
  WorkbookRow,
  WorkflowContext,
} from "@/lib/domain/types";
import { sealComparison, sealPreflight, verifiedPreflight, verifyComparisons } from "./seal";
import { getMembership, getTestSet, getTestSetCases, removeFromTestSet, SpiraError } from "./spira";

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
