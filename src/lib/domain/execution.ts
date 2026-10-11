import { effectiveColumn } from "./board";
import type {
  Card,
  Draft,
  DraftExecution,
  ExecutedStep,
  ExecutionProgress,
  ExecutionStatus,
  StepStatus,
  TestCaseStep,
} from "./types";

/** Spira's execution status IDs. */
export const EXECUTION_STATUS = { failed: 1, passed: 2, notRun: 3, notApplicable: 4, blocked: 5, caution: 6 } as const;

export const EXECUTION_STATUS_NAMES: Record<number, string> = {
  1: "Failed",
  2: "Passed",
  3: "Not Run",
  4: "N/A",
  5: "Blocked",
  6: "Caution",
};

/** Statuses that mean a run was recorded (Failed, Passed, Blocked, Caution). */
export const EXECUTED_STATUS_IDS = new Set<number>([1, 2, 5, 6]);

export const STATUS_LABEL: Record<StepStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  caution: "Caution",
  notApplicable: "N/A",
};

/** How a Spira status ID reads as one of the app's results; null for Not Run and N/A. */
export function statusFromId(statusId: number | null | undefined): ExecutionStatus | null {
  switch (statusId) {
    case EXECUTION_STATUS.passed:
      return "passed";
    case EXECUTION_STATUS.failed:
      return "failed";
    case EXECUTION_STATUS.blocked:
      return "blocked";
    case EXECUTION_STATUS.caution:
      return "caution";
    default:
      return null;
  }
}

export function emptyExecution(): DraftExecution {
  return { runs: [], progress: {}, spira: {}, checkedAt: null };
}

export function emptyProgress(): ExecutionProgress {
  return { steps: {}, status: null, comment: "" };
}

/** In Scope cards: the cases to execute. */
export function executionCards(draft: Draft): Card[] {
  return draft.testSets.flatMap((set) => set.cards.filter((card) => effectiveColumn(card, draft.decisions) === "inScope"));
}

export interface RunnableStep {
  label: string;
  /** Name of the linked test case this step belongs to, if any. */
  linkedFrom: string | null;
  step: TestCaseStep;
}

/**
 * Steps in the order a tester runs them. A step that calls another test case is replaced by that
 * case's steps ("3.1", "3.2"); if those were not loaded, the call itself is the step.
 */
export function runnableSteps(steps: TestCaseStep[], prefix = "", linkedFrom: string | null = null): RunnableStep[] {
  return steps.flatMap((step, i) => {
    const label = `${prefix}${i + 1}`;
    if (step.linkedTestCaseId && step.linkedSteps.length > 0) {
      return runnableSteps(step.linkedSteps, `${label}.`, step.linkedName ?? `TC${step.linkedTestCaseId}`);
    }
    return [{ label, linkedFrom, step }];
  });
}

const SEVERITY: ExecutionStatus[] = ["failed", "blocked", "caution"];

/**
 * The case result that follows from its steps: the first of Failed, Blocked or Caution found in any step
 * (a tester can stop at the first failure), otherwise Passed once every step is Passed or N/A and at least
 * one passed. Null while that cannot be decided yet.
 */
export function caseStatus(statuses: Array<StepStatus | null>): ExecutionStatus | null {
  for (const status of SEVERITY) if (statuses.includes(status)) return status;
  if (statuses.length === 0 || statuses.some((s) => s === null)) return null;
  return statuses.includes("passed") ? "passed" : null;
}

/** Status of a case from its saved progress and steps (or the status picked for a case without steps). */
export function progressStatus(progress: ExecutionProgress | undefined, steps: RunnableStep[]): ExecutionStatus | null {
  if (!progress) return null;
  if (steps.length === 0) return progress.status;
  return caseStatus(steps.map((s) => progress.steps[s.label]?.status ?? null));
}

/** Steps with what the tester found, in the shape sent to the server. */
export function executedSteps(progress: ExecutionProgress | undefined, steps: RunnableStep[]): ExecutedStep[] {
  return steps.map(({ label, step }) => ({
    label,
    testStepId: step.testStepId,
    linkedTestCaseId: step.linkedTestCaseId,
    description: step.description || (step.linkedTestCaseId ? `Calls TC${step.linkedTestCaseId}` : ""),
    expectedResult: step.expectedResult,
    status: progress?.steps[label]?.status ?? null,
    actualResult: progress?.steps[label]?.actualResult ?? "",
  }));
}

/** What still needs saying before a result can be saved, or null when it can be saved. */
export function missingForSave(status: ExecutionStatus | null, comment: string, steps: ExecutedStep[]): string | null {
  if (!status) return "Mark the steps, or pick a result, first.";
  if (status === "passed") return null;
  const explained = comment.trim() || steps.some((s) => s.status && s.status !== "passed" && s.status !== "notApplicable" && s.actualResult.trim());
  return explained ? null : `Say what happened: add the actual result on the ${STATUS_LABEL[status]} step, or a comment.`;
}

/** Why a result cannot be recorded as sent, or null when it is consistent. Checked on the server too. */
export function invalidResult(status: ExecutionStatus, comment: string, steps: ExecutedStep[]): string | null {
  if (steps.length > 0) {
    const fromSteps = caseStatus(steps.map((s) => s.status));
    if (fromSteps !== status) {
      return fromSteps ? `The steps say ${STATUS_LABEL[fromSteps]}, not ${STATUS_LABEL[status]}.` : "Mark every step, or stop at a failed or blocked step.";
    }
  }
  return missingForSave(status, comment, steps);
}

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

/** The short message and the full report stored on the Spira test run. */
export function runReport(input: {
  runner: string;
  tester: string;
  module: string;
  draftName: string;
  status: ExecutionStatus;
  comment: string;
  steps: ExecutedStep[];
}): { message: string; details: string } {
  const label = STATUS_LABEL[input.status];
  const by = input.tester ? ` by ${input.tester}` : "";
  const problem = input.steps.find((s) => s.status === input.status && input.status !== "passed");
  const summary =
    firstLine(input.comment) ||
    (problem ? `step ${problem.label}${firstLine(problem.actualResult) ? `: ${firstLine(problem.actualResult)}` : ""}` : "") ||
    (input.steps.length ? `${input.steps.length} step${input.steps.length === 1 ? "" : "s"} executed` : "whole case");

  const lines = [
    `Executed with ${input.runner}${by || " (tester not named)"} for module ${input.module} (draft "${input.draftName}").`,
    `Result: ${label}`,
  ];
  if (input.comment.trim()) lines.push(`Comment: ${input.comment.trim()}`);
  lines.push("");
  if (input.steps.length === 0) lines.push("Recorded for the case as a whole, without step results.");
  for (const s of input.steps) {
    lines.push(`Step ${s.label} - ${s.status ? STATUS_LABEL[s.status] : "Not run"}`);
    if (s.description.trim()) lines.push(`  Action: ${s.description.trim().replace(/\n/g, "\n          ")}`);
    if (s.expectedResult.trim()) lines.push(`  Expected: ${s.expectedResult.trim().replace(/\n/g, "\n            ")}`);
    if (s.actualResult.trim()) lines.push(`  Actual: ${s.actualResult.trim().replace(/\n/g, "\n          ")}`);
  }
  return { message: `${label}${by}: ${summary}`.slice(0, 255), details: lines.join("\n").slice(0, 100_000) };
}

/** One step of the manual run Spira creates for a test case, with linked cases already expanded. */
export interface RunStepSlot {
  testStepId: number | null;
  /** The test case the step belongs to: the executed case, or a case it calls. */
  testCaseId: number | null;
}

export interface FilledRunStep {
  status: StepStatus | null;
  actualResult: string;
}

/** Marks a manual run as made by this app; undo only deletes manual runs carrying it. */
export function runSignature(runner: string): string {
  return `with ${runner}.`;
}

/** Comment and tester, added to the actual result of the step that decided the run. */
export function runNote(input: { runner: string; tester: string; comment: string }): string {
  return [
    input.comment.trim() ? `Comment: ${input.comment.trim()}` : null,
    `Executed by ${input.tester.trim() || "an unnamed tester"} ${runSignature(input.runner)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The tester's marks laid onto the steps of Spira's run. Steps are matched by test step ID (in order,
 * so a case called twice matches twice); steps of a called case that was not loaded here take the
 * status of the call; failing that, steps are matched by position when the counts agree. A Passed
 * result without step marks passes every step; any other result without step marks goes on the first
 * step. Returns null when the steps in Spira do not give the same result, so nothing is saved.
 */
export function fillRunSteps(slots: RunStepSlot[], result: ExecutionStatus, steps: ExecutedStep[], note: string): FilledRunStep[] | null {
  if (slots.length === 0) return null;
  let filled: FilledRunStep[];
  if (steps.length === 0) {
    filled = slots.map((_, i) => ({ status: result === "passed" || i === 0 ? result : null, actualResult: "" }));
  } else {
    const byStep = new Map<number, ExecutedStep[]>();
    const byCall = new Map<number, ExecutedStep>();
    for (const step of steps) {
      if (step.linkedTestCaseId) byCall.set(step.linkedTestCaseId, step);
      else if (step.testStepId) byStep.set(step.testStepId, [...(byStep.get(step.testStepId) ?? []), step]);
    }
    const used = new Set<ExecutedStep>();
    const matched: Array<ExecutedStep | null> = slots.map((slot) => {
      const next = slot.testStepId ? byStep.get(slot.testStepId)?.shift() : undefined;
      if (next) return next;
      return slot.testCaseId ? (byCall.get(slot.testCaseId) ?? null) : null;
    });
    if (matched.some((m) => !m) && slots.length === steps.length) {
      matched.forEach((m, i) => {
        if (!m) matched[i] = steps[i];
      });
    }
    filled = matched.map((m) => {
      if (!m) return { status: result === "passed" ? "passed" : null, actualResult: "" };
      const first = !used.has(m);
      used.add(m);
      return { status: m.status, actualResult: first ? m.actualResult.trim() : "" };
    });
  }
  if (caseStatus(filled.map((f) => f.status)) !== result) return null;
  const decisive = result === "passed" ? filled.length - 1 : filled.findIndex((f) => f.status === result);
  const target = filled[decisive];
  target.actualResult = [target.actualResult, note].filter(Boolean).join("\n\n");
  return filled;
}

export interface ExecutionCounts {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  caution: number;
  notRun: number;
}

/** Counts of In Scope cases by their latest status in Spira. */
export function executionCounts(cards: Card[], execution: DraftExecution | undefined): ExecutionCounts {
  const counts: ExecutionCounts = { total: cards.length, passed: 0, failed: 0, blocked: 0, caution: 0, notRun: 0 };
  for (const card of cards) {
    const status = currentStatus(card, execution);
    if (status) counts[status] += 1;
    else counts.notRun += 1;
  }
  return counts;
}

/** Latest known result of a case: from the last Spira read, or from the comparison before any read. */
export function currentStatus(card: Card, execution: DraftExecution | undefined): ExecutionStatus | null {
  const read = execution?.spira[card.key];
  if (read) return statusFromId(read.statusId);
  const fromComparison = Object.entries(EXECUTION_STATUS_NAMES).find(([, name]) => name === card.executionStatus);
  return statusFromId(fromComparison ? Number(fromComparison[0]) : null);
}
