import { chunk, MAX_APPLY_BATCH } from "@/lib/domain/board";
import { recordExecutionResults, recordExecutionStatus, recordExecutionUndo, saveExecutionProgress } from "@/lib/domain/draft-ops";
import { STATUS_LABEL } from "@/lib/domain/execution";
import type {
  Draft,
  ExecutionCaseInput,
  ExecutionProgress,
  ExecutionResult,
  ExecutionRun,
  TestSetExecutionStatus,
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

/** Reads the latest execution status of every case from Spira (read only). */
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

export function saveProgress(draftId: string, key: string, progress: ExecutionProgress | null): Draft {
  return mutateDraft(draftId, (d) => saveExecutionProgress(d, key, progress));
}

/** Records results in Spira, a few cases per request, and keeps each recorded run for undo. */
export async function recordResults(
  draftId: string,
  testSetId: number,
  cases: ExecutionCaseInput[],
  tester: string,
): Promise<{ draft: Draft; results: ExecutionResult[] }> {
  const draft = getDraft(draftId);
  const all: ExecutionResult[] = [];
  let updated = draft;
  for (const batch of chunk(cases, MAX_APPLY_BATCH)) {
    const { results } = await api<{ results: ExecutionResult[] }>("/api/execution/record", {
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
    updated = mutateDraft(draftId, (d) => recordExecutionResults(d, results, batch, tester));
  }
  const count = (outcome: ExecutionResult["result"]) => all.filter((r) => r.result === outcome).length;
  const recorded = all.filter((r) => r.result === "recorded");
  logActivity({
    type: count("failed") ? "execution.recordedWithErrors" : "execution.recorded",
    message:
      recorded.length === 1 && all.length === 1
        ? `Executed TC${recorded[0].testCaseId}: ${STATUS_LABEL[recorded[0].status]}${tester ? ` (${tester})` : ""}.`
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
