import "server-only";
import { validateApplyBatch, type ApplyBatchInput } from "@/lib/domain/apply-rules";
import { allCards, diffMembership, intendedMembership, normalizeDecisions } from "@/lib/domain/board";
import type {
  ApplyActionResult,
  Column,
  MockState,
  Platform,
  PreflightResult,
  TestSetComparison,
  VerificationResult,
  WorkbookRow,
  WorkflowContext,
} from "@/lib/domain/types";
import type { EndpointOverrides } from "./endpoint-overrides";
import { emptyMockState, mockApply, mockReconcile, type ReconcileOutput } from "./mock";
import { AutomationError, n8nApply, n8nReconcile } from "./n8n";
import { sealComparison, sealPreflight, verifiedPreflight, verifyComparisons } from "./seal";

// Stateless: every request carries the board it acts on. Anything that decides what
// may be removed is checked against the server's own signatures before it is used.

export interface TestSetRef {
  testSetId: number;
  testSetName: string;
  platform: Platform;
}

async function reconcileOnce(
  ctx: WorkflowContext,
  set: TestSetRef,
  rows: WorkbookRow[],
  mockState: MockState,
  overrides: EndpointOverrides,
): Promise<ReconcileOutput> {
  if (ctx.mock) return mockReconcile(mockState, set.testSetId, ctx.module);
  return n8nReconcile(overrides.reconcileUrl, {
    projectId: ctx.projectId,
    releaseId: ctx.releaseId,
    module: ctx.module,
    testSetId: set.testSetId,
    testSetName: set.testSetName,
    platform: set.platform,
    rows,
  });
}

/** Verified comparisons plus decisions reduced to genuine overrides of those cards. */
function verifiedBoard(ctx: WorkflowContext, testSets: TestSetComparison[], decisions: Record<string, Column>) {
  const sets = verifyComparisons(ctx, testSets);
  return { sets, decisions: normalizeDecisions(allCards(sets), decisions) };
}

export async function reconcileTestSet(
  input: { context: WorkflowContext; testSet: TestSetRef; rows: WorkbookRow[]; mockState?: MockState },
  overrides: EndpointOverrides,
): Promise<{ comparison: TestSetComparison }> {
  const { context: ctx, testSet } = input;
  const output = await reconcileOnce(ctx, testSet, input.rows, input.mockState ?? emptyMockState(), overrides);
  const comparison = sealComparison(ctx, {
    testSetId: testSet.testSetId,
    testSetName: testSet.testSetName,
    platform: testSet.platform,
    comparedAt: new Date().toISOString(),
    cards: output.cards,
    missingFromSpira: output.missingFromSpira,
    baselineMembership: [...output.membership].sort((a, b) => a - b),
  });
  return { comparison };
}

/** Freshly reconciles every set and checks membership still matches the reviewed baseline. */
export async function runPreflight(
  input: {
    context: WorkflowContext;
    rows: WorkbookRow[];
    testSets: TestSetComparison[];
    decisions: Record<string, Column>;
    removed: Record<string, number[]>;
    mockState?: MockState;
  },
  overrides: EndpointOverrides,
): Promise<{ preflight: PreflightResult }> {
  const ctx = input.context;
  const { sets: verified, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  const sets = await Promise.all(
    verified.map(async (set) => {
      const alreadyRemoved = new Set(input.removed[String(set.testSetId)] ?? []);
      const expected = set.baselineMembership.filter((id) => !alreadyRemoved.has(id));
      try {
        const fresh = await reconcileOnce(ctx, set, input.rows, input.mockState ?? emptyMockState(), overrides);
        const diff = diffMembership(expected, fresh.membership);
        return {
          testSetId: set.testSetId,
          ok: diff.unexpected.length === 0 && diff.missing.length === 0,
          ...diff,
        };
      } catch (error) {
        return {
          testSetId: set.testSetId,
          ok: false,
          unexpected: [],
          missing: [],
          error: error instanceof Error ? error.message : "Reconciliation failed.",
        };
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

/** Remove-only, batched apply against a verified board. */
export async function applyBatch(
  input: {
    context: WorkflowContext;
    testSets: TestSetComparison[];
    decisions: Record<string, Column>;
    removed: Record<string, number[]>;
    preflight: PreflightResult | null;
    batch: ApplyBatchInput;
    mockState?: MockState;
  },
  overrides: EndpointOverrides,
): Promise<{ results: ApplyActionResult[]; mockState?: MockState }> {
  const ctx = input.context;
  const { batch } = input;
  const { sets, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  validateApplyBatch(
    { module: ctx.module, testSets: sets, decisions, preflight: verifiedPreflight(ctx, input.preflight, sets, decisions) },
    batch,
  );

  const alreadyRemoved = new Set(input.removed[String(batch.testSetId)] ?? []);
  const skipped: ApplyActionResult[] = [];
  const toSend = batch.actions.filter((action) => {
    if (!batch.dryRun && alreadyRemoved.has(action.testSetTestCaseId)) {
      skipped.push({ ...action, status: "skipped", message: "Already removed in an earlier run." });
      return false;
    }
    return true;
  });

  let sent: ApplyActionResult[] = [];
  let mockState = input.mockState;
  if (toSend.length > 0) {
    if (ctx.mock) {
      const out = mockApply(mockState ?? emptyMockState(), batch.testSetId, toSend, batch.dryRun);
      sent = out.results;
      mockState = out.state;
    } else {
      try {
        sent = await n8nApply(overrides.applyUrl, {
          projectId: ctx.projectId,
          releaseId: ctx.releaseId,
          testSetId: batch.testSetId,
          dryRun: batch.dryRun,
          actions: toSend,
        });
      } catch (error) {
        if (!(error instanceof AutomationError)) throw error;
        sent = toSend.map((action) => ({ ...action, status: "failed", message: error.message }));
      }
    }
  }
  return { results: [...skipped, ...sent], ...(ctx.mock ? { mockState } : {}) };
}

/** Reconciles again after live apply and compares final membership with the intended membership. */
export async function verifyApply(
  input: {
    context: WorkflowContext;
    rows: WorkbookRow[];
    testSets: TestSetComparison[];
    decisions: Record<string, Column>;
    mockState?: MockState;
  },
  overrides: EndpointOverrides,
): Promise<{ verification: VerificationResult }> {
  const ctx = input.context;
  const { sets: verified, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  const sets = await Promise.all(
    verified.map(async (set) => {
      const intended = intendedMembership(set, decisions);
      try {
        const fresh = await reconcileOnce(ctx, set, input.rows, input.mockState ?? emptyMockState(), overrides);
        const diff = diffMembership(intended, fresh.membership);
        return {
          testSetId: set.testSetId,
          ok: diff.unexpected.length === 0 && diff.missing.length === 0,
          stillPresent: diff.unexpected,
          unexpectedlyRemoved: diff.missing,
        };
      } catch (error) {
        return {
          testSetId: set.testSetId,
          ok: false,
          stillPresent: [],
          unexpectedlyRemoved: [],
          error: error instanceof Error ? error.message : "Reconciliation failed.",
        };
      }
    }),
  );
  return { verification: { at: new Date().toISOString(), ok: sets.length > 0 && sets.every((s) => s.ok), sets } };
}
