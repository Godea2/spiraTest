import { chunk } from "@/lib/domain/board";
import { recordExecutionResults, recordExecutionStatus, recordExecutionUndo, recordTestSetUpkeep, saveExecutionProgress } from "@/lib/domain/draft-ops";
import { MAX_EXECUTION_BATCH, STATUS_LABEL } from "@/lib/domain/execution";
import type {
  Draft,
  ExecutionCaseInput,
  ExecutionProgress,
  ExecutionResult,
  ExecutionRun,
  TestSetExecutionStatus,
  TestSetUpkeep,
} from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api } from "./api";
import { getDraft, mutateDraft } from "./drafts";
import { readItem, writeItem } from "./storage";
import { contextOf } from "./workflow";

const TESTER_KEY = "tester";

/** The tester's name, kept in this browser and written on every run they record. */
export function getTester(): string {
  return readItem<string>(TESTER_KEY) ?? "";
}

export function setTester(name: string): void {
  writeItem(TESTER_KEY, name.trim().slice(0, 100));
}

/** Reads the latest execution status of every case, and each test set's own status, from Spira (read only). */
export async function refreshExecution(draftId: string, testSetIds?: number[]): Promise<{ draft: Draft; errors: string[] }> {
  const draft = getDraft(draftId);
  const { sets } = await api<{ sets: TestSetExecutionStatus[] }>("/api/execution/status", {
    method: "POST",
    body: { projectId: draft.projectId, testSetIds: testSetIds ?? draft.testSets.map((s) => s.testSetId) },
  });
  const updated = mutateDraft(draftId, (d) => recordExecutionStatus(d, sets, new Date().toISOString()));
  const name = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `Test set ${id}`;
  return { draft: updated, errors: sets.flatMap((s) => (s.error ? [`${name(s.testSetId)}: ${s.error}`] : [])) };
}

/** Sets a test set's status in Spira to the one its cases call for. */
export async function settleTestSetStatus(draftId: string, testSetId: number): Promise<{ draft: Draft; upkeep: TestSetUpkeep }> {
  const draft = getDraft(draftId);
  const upkeep = await api<TestSetUpkeep>("/api/execution/test-set-status", { method: "POST", body: { projectId: draft.projectId, testSetId } });
  if (upkeep.error) throw new Error(upkeep.error);
  const updated = mutateDraft(draftId, (d) => recordTestSetUpkeep(d, upkeep));
  if (upkeep.changedStatus) {
    logActivity({
      type: "execution.testSetStatus",
      message: `Set test set ${testSetId} to ${upkeep.statusName} in Spira, to match its cases.`,
      draftId,
      module: draft.module,
      details: { testSetId, status: upkeep.statusName },
    });
  }
  return { draft: updated, upkeep };
}

export function saveProgress(draftId: string, key: string, progress: ExecutionProgress | null): Draft {
  return mutateDraft(draftId, (d) => saveExecutionProgress(d, key, progress));
}

/**
 * Records results in Spira in batches, and keeps each recorded run for undo. `onBatch` reports
 * progress after each batch; returning false from `keepGoing` stops before the next one.
 */
export async function recordResults(
  draftId: string,
  testSetId: number,
  cases: ExecutionCaseInput[],
  tester: string,
  options: { onBatch?: (done: number, draft: Draft) => void; keepGoing?: () => boolean } = {},
): Promise<{ draft: Draft; results: ExecutionResult[] }> {
  const draft = getDraft(draftId);
  const all: ExecutionResult[] = [];
  let updated = draft;
  for (const batch of chunk(cases, MAX_EXECUTION_BATCH)) {
    if (options.keepGoing && !options.keepGoing()) break;
    const { results, testSet } = await api<{ results: ExecutionResult[]; testSet?: TestSetUpkeep }>("/api/execution/record", {
      method: "POST",
      body: {
        context: contextOf(draft),
        testSets: draft.testSets,
        decisions: draft.decisions,
        draftName: draft.name,
        tester,
        batch: { testSetId, cases: batch },
      },
    });
    all.push(...results);
    updated = mutateDraft(draftId, (d) => {
      recordExecutionResults(d, results, batch, tester);
      if (testSet) recordTestSetUpkeep(d, testSet);
    });
    if (testSet && (testSet.changedStatus || testSet.restored.length)) {
      logActivity({
        type: "execution.testSetUpkeep",
        message: `Kept test set ${testSetId} right in Spira after recording:${testSet.changedStatus ? ` status ${testSet.statusName}` : ""}${testSet.restored.length ? `${testSet.changedStatus ? ";" : ""} restored ${testSet.restored.join(" and ")}` : ""}.`,
        draftId,
        module: draft.module,
        details: { testSetId, status: testSet.statusName, restored: testSet.restored },
      });
    }
    options.onBatch?.(all.length, updated);
  }
  const count = (outcome: ExecutionResult["result"]) => all.filter((r) => r.result === outcome).length;
  const recorded = all.filter((r) => r.result === "recorded");
  logActivity({
    type: count("failed") ? "execution.recordedWithErrors" : "execution.recorded",
    message:
      recorded.length === 1 && all.length === 1
        ? `Executed TC${recorded[0].testCaseId}: ${recorded[0].status === "notRun" ? "Not Run" : STATUS_LABEL[recorded[0].status]}${tester ? ` (${tester})` : ""}.`
        : `Recorded ${recorded.length} execution result(s) in test set ${testSetId}${count("skipped") ? `, ${count("skipped")} skipped` : ""}${count("failed") ? `, ${count("failed")} failed` : ""}.`,
    draftId,
    module: draft.module,
    details: {
      testSetId,
      tester,
      testRunIds: recorded.map((r) => r.testRunId),
      failed: all.filter((r) => r.result === "failed").map((r) => r.testSetTestCaseId),
    },
  });
  return { draft: updated, results: all };
}

/** Deletes a run this app recorded, then reads the case's status again, which falls back to the run before it. */
export async function undoRun(draftId: string, run: ExecutionRun): Promise<Draft> {
  const draft = getDraft(draftId);
  const { results } = await api<{ results: { testRunId: number; ok: boolean; message: string | null }[] }>("/api/workflow/undo-sign-off", {
    method: "POST",
    body: { context: contextOf(draft), runs: [{ testRunId: run.testRunId, testCaseId: run.testCaseId }] },
  });
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(failed.message ?? "The test run could not be deleted.");
  mutateDraft(draftId, (d) => recordExecutionUndo(d, [run.testRunId]));
  logActivity({
    type: "execution.undone",
    message: `Undid the ${STATUS_LABEL[run.status]} result for TC${run.testCaseId} (test run ${run.testRunId} deleted from Spira).`,
    draftId,
    module: draft.module,
    details: { testRunId: run.testRunId, testSetId: run.testSetId },
  });
  try {
    return (await refreshExecution(draftId, [run.testSetId])).draft;
  } catch {
    return getDraft(draftId);
  }
}
