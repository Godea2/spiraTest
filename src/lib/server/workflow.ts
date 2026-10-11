import "server-only";
import { ApplyValidationError, SIGN_OFF_COLUMN, validateApplyBatch, type ApplyBatchInput } from "@/lib/domain/apply-rules";
import { allCards, diffMembership, effectiveColumn, intendedMembership, isExecutedColumn, normalizeDecisions } from "@/lib/domain/board";
import { expectedTestSetStatus, fillRunSteps, invalidResult, runNote, runReport, TEST_SET_STATUS_NAMES } from "@/lib/domain/execution";
import { reconcileTestSet as matchTestSet } from "@/lib/domain/matching";
import type {
  ApplyAction,
  ApplyActionResult,
  Column,
  DefectCaseCreated,
  DefectLogResult,
  ExecutionCaseInput,
  ExecutionResult,
  Platform,
  PreflightResult,
  SignOffResult,
  SignOffStatus,
  TestSetComparison,
  TestSetExecutionStatus,
  TestSetUpkeep,
  VerificationResult,
  WorkbookRow,
  WorkflowContext,
} from "@/lib/domain/types";
import { testCaseSignature } from "@/lib/domain/defects";
import { sealComparison, sealPreflight, verifiedPreflight, verifyComparisons } from "./seal";
import {
  addTestStep,
  addToTestSet,
  createIncident,
  createTestCase,
  deleteCreatedTestCase,
  getTestCaseFolderId,
  createManualRunShells,
  deleteLoggedIncident,
  deleteRecordedTestRun,
  getRecordedRunSteps,
  EXECUTION_STATUS,
  getMembership,
  getTestSet,
  getTestSetCases,
  getTestSetRecord,
  updateTestSet,
  type TestSetRecord,
  recordTestRun,
  removeFromTestSet,
  RUNNER_NAME,
  saveManualRuns,
  SpiraError,
  type ManualRunInput,
  type ManualRunShell,
  type SpiraSetCase,
} from "./spira";

// Stateless: every request carries the board it acts on. Anything that decides what
// may be removed is checked against the server's own signatures before it is used.

/**
 * Spira writes run one at a time: parallel removals from the same test set made Spira answer HTTP 400
 * for a whole batch (some of which it had applied anyway). Batches are small enough to stay inside
 * the function time limit when sent one by one.
 */
const WRITE_CONCURRENCY = 1;

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

/**
 * Recording runs makes Spira update the test set on its own: it can mark it Completed while cases are
 * still Not Run, and clear its owner and planned date. Sets the status its cases call for, and puts
 * back an owner or planned date that was there before the runs were saved. Never throws for Spira errors.
 */
async function keepTestSet(projectId: number, before: TestSetRecord, caseStatusIds?: Array<number | null>): Promise<TestSetUpkeep> {
  const upkeep: TestSetUpkeep = { testSetId: before.testSetId, statusId: null, statusName: null, changedStatus: false, restored: [] };
  try {
    const statuses = caseStatusIds ?? (await getTestSetCases(projectId, before.testSetId)).map((c) => c.executionStatusId);
    const now = await getTestSetRecord(projectId, before.testSetId);
    const changes: Record<string, unknown> = {};
    const expected = expectedTestSetStatus(now.statusId, statuses);
    if (expected !== null && expected !== now.statusId) {
      changes.TestSetStatusId = expected;
      upkeep.changedStatus = true;
    }
    if (before.ownerId && !now.ownerId) {
      changes.OwnerId = before.ownerId;
      upkeep.restored.push("owner");
    }
    if (before.plannedDate && !now.plannedDate) {
      changes.PlannedDate = before.plannedDate;
      upkeep.restored.push("planned date");
    }
    if (Object.keys(changes).length > 0) await updateTestSet(projectId, now, changes);
    upkeep.statusId = (changes.TestSetStatusId as number | undefined) ?? now.statusId;
    upkeep.statusName = upkeep.statusId ? (TEST_SET_STATUS_NAMES[upkeep.statusId] ?? null) : null;
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    upkeep.error = `The test set's status could not be kept up to date: ${error.message}`;
  }
  return upkeep;
}

/** Sets a test set's status to the one its cases in Spira call for. Writes only when it differs. */
export async function settleTestSetStatus(input: { projectId: number; testSetId: number }): Promise<TestSetUpkeep> {
  const before = await getTestSetRecord(input.projectId, input.testSetId);
  return keepTestSet(input.projectId, before);
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

  const writeFailed = new Set<number>();
  const results = await inPool(batch.actions, WRITE_CONCURRENCY, async (action): Promise<ApplyActionResult> => {
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
      writeFailed.add(action.testSetTestCaseId);
      return result(action, "failed", error.message);
    }
  });

  // Spira sometimes reports an error for a removal it did apply; count those as removed so the
  // next membership check does not see them as changed in Spira.
  if (writeFailed.size > 0) {
    try {
      const after = await getMembership(ctx.projectId, batch.testSetId);
      for (const [i, r] of results.entries()) {
        if (writeFailed.has(r.testSetTestCaseId) && !after.has(r.testSetTestCaseId)) {
          results[i] = result(r, "removed", "Spira reported an error, but the case is no longer in the test set.");
        }
      }
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
    }
  }
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
}): Promise<{ results: SignOffResult[]; testSet?: TestSetUpkeep }> {
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
  let before: TestSetRecord;
  try {
    const [spiraSet, list] = await Promise.all([
      getTestSetRecord(ctx.projectId, batch.testSetId),
      getTestSetCases(ctx.projectId, batch.testSetId),
    ]);
    cases = new Map(list.map((c) => [c.testSetTestCaseId, c]));
    releaseId = ctx.releaseId ?? spiraSet.releaseId;
    before = spiraSet;
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    return { results: batch.actions.map((action) => result(action, "failed", error.message)) };
  }

  const blocked = batch.status === "blocked";
  const results = await inPool(batch.actions, WRITE_CONCURRENCY, async (action): Promise<SignOffResult> => {
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
  const testSet = results.some((r) => r.result === "recorded") ? await keepTestSet(ctx.projectId, before) : undefined;
  return { results, testSet };
}

/** Read-only: the current execution status of every membership in the given test sets, and of each test set. */
export async function readExecutionStatus(input: { projectId: number; testSetIds: number[] }): Promise<{ sets: TestSetExecutionStatus[] }> {
  const sets = await inPool(input.testSetIds, 3, async (testSetId): Promise<TestSetExecutionStatus> => {
    try {
      const [cases, record] = await Promise.all([getTestSetCases(input.projectId, testSetId), getTestSetRecord(input.projectId, testSetId)]);
      const expectedId = expectedTestSetStatus(
        record.statusId,
        cases.map((c) => c.executionStatusId),
      );
      return {
        testSetId,
        cases: cases.map((c) => ({ testSetTestCaseId: c.testSetTestCaseId, testCaseId: c.testCaseId, statusId: c.executionStatusId, status: c.executionStatus })),
        testSetStatus: {
          statusId: record.statusId,
          name: record.statusId ? (TEST_SET_STATUS_NAMES[record.statusId] ?? "Unknown") : "Unknown",
          expectedId: expectedId !== null && expectedId !== record.statusId ? expectedId : null,
        },
      };
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
      return { testSetId, cases: [], error: error.message };
    }
  });
  return { sets };
}

/**
 * Records a manual test run for each executed case, with the tester's status and actual result on
 * each step, as Spira's own execution screen would. The whole batch is prepared in one Spira call
 * and saved in another. A case Spira gives no steps is recorded as an automated run with the report
 * in its details.
 * Only In Scope cases of a verified board can be recorded, and the test set is re-read first so a
 * case is only recorded while it is still in the set and still the same test case. A case can be
 * executed again: Spira keeps every run and shows the latest result.
 */
export async function recordExecutions(input: {
  context: WorkflowContext;
  testSets: TestSetComparison[];
  decisions: Record<string, Column>;
  draftName: string;
  tester: string;
  batch: { testSetId: number; cases: ExecutionCaseInput[] };
}): Promise<{ results: ExecutionResult[]; testSet?: TestSetUpkeep }> {
  const ctx = input.context;
  const { batch } = input;
  const { sets, decisions } = verifiedBoard(ctx, input.testSets, input.decisions);
  const set = sets.find((s) => s.testSetId === batch.testSetId);
  if (!set) throw new ApplyValidationError(`Test set ${batch.testSetId} is not part of this draft.`);
  const seen = new Set<number>();
  for (const c of batch.cases) {
    if (seen.has(c.testSetTestCaseId)) throw new ApplyValidationError(`Membership ${c.testSetTestCaseId} appears twice in this batch.`);
    seen.add(c.testSetTestCaseId);
    const card = set.cards.find((k) => k.testSetTestCaseId === c.testSetTestCaseId);
    if (!card || card.testCaseId !== c.testCaseId) throw new ApplyValidationError(`TC${c.testCaseId} is not on this board.`);
    if (!isExecutedColumn(effectiveColumn(card, decisions))) throw new ApplyValidationError(`TC${c.testCaseId} is not In Scope, so it is not executed here.`);
    const invalid = invalidResult(c.status, c.comment, c.steps);
    if (invalid) throw new ApplyValidationError(`TC${c.testCaseId}: ${invalid}`);
  }

  const result = (c: ExecutionCaseInput, outcome: ExecutionResult["result"], message: string | null = null, testRunId: number | null = null): ExecutionResult => ({
    testSetId: batch.testSetId,
    testCaseId: c.testCaseId,
    testSetTestCaseId: c.testSetTestCaseId,
    status: c.status,
    result: outcome,
    testRunId,
    message,
  });

  let cases: Map<number, SpiraSetCase>;
  let releaseId: number | null;
  let before: TestSetRecord;
  try {
    const [spiraSet, list] = await Promise.all([getTestSetRecord(ctx.projectId, batch.testSetId), getTestSetCases(ctx.projectId, batch.testSetId)]);
    cases = new Map(list.map((c) => [c.testSetTestCaseId, c]));
    releaseId = ctx.releaseId ?? spiraSet.releaseId;
    before = spiraSet;
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    return { results: batch.cases.map((c) => result(c, "failed", error.message)) };
  }

  const outcomes = new Map<number, ExecutionResult>();
  const settle = (c: ExecutionCaseInput, outcome: ExecutionResult["result"], message: string | null = null, testRunId: number | null = null) =>
    outcomes.set(c.testSetTestCaseId, result(c, outcome, message, testRunId));
  const failure = (error: unknown) => {
    if (!(error instanceof SpiraError)) throw error;
    return error;
  };

  const eligible: ExecutionCaseInput[] = [];
  for (const c of batch.cases) {
    const current = cases.get(c.testSetTestCaseId);
    if (!current) settle(c, "skipped", "No longer in this test set in Spira.");
    else if (current.testCaseId !== c.testCaseId) settle(c, "failed", `This membership now points at test case ${current.testCaseId}. Recompare first.`);
    else eligible.push(c);
  }

  // One call prepares the runs of the whole batch, with Spira's own steps; nothing is saved yet.
  const shells = new Map<number, ManualRunShell[]>();
  const takeShell = async (testCaseId: number): Promise<ManualRunShell | undefined> =>
    shells.get(testCaseId)?.shift() ?? (await createManualRunShells(ctx.projectId, [testCaseId], releaseId)).find((s) => s.raw.TestCaseId === testCaseId);
  if (eligible.length > 0) {
    try {
      for (const shell of await createManualRunShells(ctx.projectId, eligible.map((c) => c.testCaseId), releaseId)) {
        shells.set(shell.raw.TestCaseId, [...(shells.get(shell.raw.TestCaseId) ?? []), shell]);
      }
    } catch (error) {
      const message = failure(error).message;
      for (const c of eligible) settle(c, "failed", message);
      eligible.length = 0;
    }
  }

  const manual: Array<{ c: ExecutionCaseInput; run: ManualRunInput }> = [];
  const automated: ExecutionCaseInput[] = [];
  for (const c of eligible) {
    let shell: ManualRunShell | undefined;
    try {
      shell = await takeShell(c.testCaseId);
    } catch (error) {
      settle(c, "failed", failure(error).message);
      continue;
    }
    if (!shell) {
      settle(c, "failed", "Spira did not prepare a test run for this test case.");
      continue;
    }
    if (shell.steps.length === 0) {
      automated.push(c);
      continue;
    }
    const filled = fillRunSteps(shell.steps, c.status, c.steps, runNote({ runner: RUNNER_NAME, tester: input.tester, comment: c.comment }));
    if (!filled) {
      settle(c, "failed", "The steps of this test case changed in Spira. Open it with Run and mark the steps again.");
      continue;
    }
    manual.push({
      c,
      run: {
        shell,
        testSetId: batch.testSetId,
        testSetTestCaseId: c.testSetTestCaseId,
        releaseId,
        executionStatusId: EXECUTION_STATUS[c.status],
        steps: filled.map((f) => ({ executionStatusId: f.status ? EXECUTION_STATUS[f.status] : EXECUTION_STATUS.notRun, actualResult: f.actualResult })),
      },
    });
  }

  // One call saves them all. If Spira rejects the batch, each run is saved on its own so one bad
  // case does not hold back the rest; a repeated run is harmless, Spira keeps every run.
  if (manual.length > 0) {
    try {
      const ids = await saveManualRuns(ctx.projectId, manual.map((m) => m.run));
      manual.forEach((m, i) => settle(m.c, "recorded", null, ids[i]));
    } catch (error) {
      const batchError = failure(error);
      if (manual.length === 1 || batchError.upstream === null) {
        for (const m of manual) settle(m.c, "failed", batchError.message);
      } else {
        for (const m of manual) {
          try {
            settle(m.c, "recorded", null, (await saveManualRuns(ctx.projectId, [m.run]))[0]);
          } catch (single) {
            settle(m.c, "failed", failure(single).message);
          }
        }
      }
    }
  }

  for (const c of automated) {
    const report = runReport({ runner: RUNNER_NAME, tester: input.tester, module: ctx.module, draftName: input.draftName, status: c.status, comment: c.comment, steps: c.steps });
    try {
      const testRunId = await recordTestRun(ctx.projectId, {
        testCaseId: c.testCaseId,
        testSetId: batch.testSetId,
        testSetTestCaseId: c.testSetTestCaseId,
        releaseId,
        executionStatusId: EXECUTION_STATUS[c.status],
        testName: cases.get(c.testSetTestCaseId)?.name ?? `TC${c.testCaseId}`,
        message: report.message,
        details: report.details,
      });
      settle(c, "recorded", null, testRunId);
    } catch (error) {
      settle(c, "failed", failure(error).message);
    }
  }

  const results = batch.cases.map((c) => outcomes.get(c.testSetTestCaseId) ?? result(c, "failed", "Not recorded."));

  // Read the test set back, so the app shows what Spira itself now reports rather than what was sent,
  // then keep the test set's own status, owner and planned date right.
  let testSet: TestSetUpkeep | undefined;
  if (results.some((r) => r.result === "recorded")) {
    let statuses: Array<number | null> | undefined;
    try {
      const after = await getTestSetCases(ctx.projectId, batch.testSetId);
      const byMembership = new Map(after.map((c) => [c.testSetTestCaseId, c.executionStatusId]));
      for (const r of results) if (r.result === "recorded") r.spiraStatusId = byMembership.get(r.testSetTestCaseId) ?? null;
      statuses = after.map((c) => c.executionStatusId);
    } catch (error) {
      failure(error);
    }
    testSet = await keepTestSet(ctx.projectId, before, statuses);
  }
  return { results, testSet };
}

/**
 * Logs one defect as a Spira incident linked to the failed step of each given run. A defect can span
 * modules, so the runs come from one or more boards of the same Spira project. Only runs of cases In
 * Scope or in Defects on a verified board are used, and each run is read back first: it must be a
 * manual run this app recorded for that test case, with a Failed step. Runs that do not qualify are
 * reported and left out; when none qualifies nothing is created. The incident is a write and is never
 * retried.
 */
export async function logDefect(input: {
  boards: Array<{ context: WorkflowContext; testSets: TestSetComparison[]; decisions: Record<string, Column> }>;
  defect: { name: string; description: string; typeId: number | null; priorityId: number | null; severityId: number | null };
  runs: Array<{ board: number; testRunId: number; testCaseId: number; testSetId: number; testSetTestCaseId: number }>;
}): Promise<DefectLogResult> {
  const projectId = input.boards[0].context.projectId;
  if (input.boards.some((b) => b.context.projectId !== projectId)) throw new ApplyValidationError("Every module of a defect must be in the same Spira project.");
  const boards = input.boards.map((b) => ({ context: b.context, ...verifiedBoard(b.context, b.testSets, b.decisions) }));
  const seen = new Set<number>();
  for (const run of input.runs) {
    if (seen.has(run.testRunId)) throw new ApplyValidationError(`Test run ${run.testRunId} appears twice.`);
    seen.add(run.testRunId);
    const board = boards[run.board];
    if (!board) throw new ApplyValidationError(`Test run ${run.testRunId} names a module that was not sent.`);
    const card = board.sets.find((s) => s.testSetId === run.testSetId)?.cards.find((c) => c.testSetTestCaseId === run.testSetTestCaseId);
    if (!card || card.testCaseId !== run.testCaseId) throw new ApplyValidationError(`TC${run.testCaseId} is not on the ${board.context.module} board.`);
    if (!isExecutedColumn(effectiveColumn(card, board.decisions))) throw new ApplyValidationError(`TC${run.testCaseId} is not In Scope or in Defects.`);
  }

  const linked: DefectLogResult["linked"] = [];
  const unlinked: DefectLogResult["unlinked"] = [];
  let releaseId: number | null = null;
  const reads = await inPool(input.runs, 3, async (run) => {
    try {
      return { run, steps: await getRecordedRunSteps(projectId, run.testRunId), error: null };
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
      return { run, steps: null, error: error.message };
    }
  });
  for (const { run, steps, error } of reads) {
    if (!steps) {
      unlinked.push({ testRunId: run.testRunId, message: error ?? "The run could not be read." });
      continue;
    }
    if (steps.testCaseId !== run.testCaseId || !steps.ours) {
      unlinked.push({ testRunId: run.testRunId, message: `Test run ${run.testRunId} was not recorded here for TC${run.testCaseId}.` });
    } else if (steps.failedStepIds.length === 0) {
      unlinked.push({ testRunId: run.testRunId, message: `Test run ${run.testRunId} has no Failed step.` });
    } else {
      linked.push({ testRunId: run.testRunId, testRunStepId: steps.failedStepIds[0] });
      releaseId ??= boards[run.board].context.releaseId ?? steps.releaseId;
    }
  }
  if (linked.length === 0) {
    throw new ApplyValidationError(`No run could be linked, so no incident was logged. ${unlinked.map((u) => u.message).join(" ")}`.trim());
  }

  const incidentId = await createIncident(projectId, {
    ...input.defect,
    releaseId,
    testRunStepIds: linked.map((l) => l.testRunStepId),
  });
  return { incidentId, linked, unlinked };
}

/**
 * Creates a test case for a defect no existing case covers and adds it to the chosen test sets, each on
 * a verified board of the same project. The case goes in the folder of the test set's first case and
 * carries the app's signature, so only it can be deleted by undo. If any step fails, what was created is
 * removed again and nothing is left behind. Writes are never retried.
 */
export async function createDefectCase(input: {
  boards: Array<{ context: WorkflowContext; testSets: TestSetComparison[]; decisions: Record<string, Column> }>;
  testCase: { name: string; description: string; statusId?: number | null; steps: Array<{ description: string; expectedResult: string }> };
  targets: Array<{ board: number; testSetId: number }>;
}): Promise<DefectCaseCreated> {
  const projectId = input.boards[0].context.projectId;
  if (input.boards.some((b) => b.context.projectId !== projectId)) throw new ApplyValidationError("Every test set must be in the same Spira project.");
  const boards = input.boards.map((b) => verifyComparisons(b.context, b.testSets));
  const seen = new Set<number>();
  for (const target of input.targets) {
    if (seen.has(target.testSetId)) throw new ApplyValidationError(`Test set ${target.testSetId} appears twice.`);
    seen.add(target.testSetId);
    if (!boards[target.board]?.some((s) => s.testSetId === target.testSetId)) {
      throw new ApplyValidationError(`Test set ${target.testSetId} is not on the board that was sent.`);
    }
  }

  const sibling = boards[input.targets[0].board].find((s) => s.testSetId === input.targets[0].testSetId)?.cards[0];
  let folderId: number | null = null;
  if (sibling) {
    try {
      folderId = await getTestCaseFolderId(projectId, sibling.testCaseId);
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
    }
  }
  const description = [input.testCase.description.trim(), testCaseSignature(RUNNER_NAME)].filter(Boolean).join("\n\n");
  const testCaseId = await createTestCase(projectId, { name: input.testCase.name, description, folderId, statusId: input.testCase.statusId ?? null });
  const memberships: DefectCaseCreated["memberships"] = [];
  try {
    for (const [index, step] of input.testCase.steps.entries()) await addTestStep(projectId, testCaseId, { position: index + 1, ...step });
    for (const target of input.targets) {
      memberships.push({ testSetId: target.testSetId, testSetTestCaseId: await addToTestSet(projectId, target.testSetId, testCaseId) });
    }
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    const leftovers: string[] = [];
    for (const m of memberships) {
      await removeFromTestSet(projectId, m.testSetId, m.testSetTestCaseId).catch(() => leftovers.push(`membership ${m.testSetTestCaseId} in test set ${m.testSetId}`));
    }
    await deleteCreatedTestCase(projectId, testCaseId).catch(() => leftovers.push(`test case ${testCaseId}`));
    throw new SpiraError(
      `${error.message}${leftovers.length ? ` These could not be removed again; delete them in Spira: ${leftovers.join(", ")}.` : " Nothing was left in Spira."}`,
      error.status,
      error.upstream,
    );
  }
  return { testCaseId, memberships };
}

/** Takes a test case this app created for a defect out of its test sets and deletes it; it is checked to be ours first. */
export async function deleteDefectCase(input: {
  projectId: number;
  testCaseId: number;
  memberships: Array<{ testSetId: number; testSetTestCaseId: number }>;
}): Promise<{ ok: true; message: string | null }> {
  try {
    await deleteCreatedTestCase(input.projectId, input.testCaseId);
  } catch (error) {
    if (error instanceof SpiraError && error.upstream === 404) return { ok: true, message: "Already deleted in Spira." };
    throw error;
  }
  for (const m of input.memberships) {
    try {
      await removeFromTestSet(input.projectId, m.testSetId, m.testSetTestCaseId);
    } catch (error) {
      // Deleting the test case already takes it out of its test sets; a membership that is gone is fine.
      if (!(error instanceof SpiraError)) throw error;
    }
  }
  return { ok: true, message: null };
}

/** Deletes an incident this app logged; it is checked to be ours first. */
export async function undoDefect(input: { projectId: number; incidentId: number }): Promise<{ ok: true; message: string | null }> {
  try {
    await deleteLoggedIncident(input.projectId, input.incidentId);
    return { ok: true, message: null };
  } catch (error) {
    if (error instanceof SpiraError && error.upstream === 404) return { ok: true, message: "Already deleted in Spira." };
    throw error;
  }
}

/** Deletes test runs this app recorded. Each run is checked to be ours before it is deleted. */
export async function undoSignOff(input: {
  context: WorkflowContext;
  runs: { testRunId: number; testCaseId: number }[];
}): Promise<{ results: { testRunId: number; ok: boolean; message: string | null }[] }> {
  const ctx = input.context;
  const results = await inPool(input.runs, WRITE_CONCURRENCY, async (run) => {
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
