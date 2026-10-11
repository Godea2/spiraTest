import { describe, expect, it } from "vitest";
import { emptyApplyState, recordExecutionResults, recordExecutionStatus, recordExecutionUndo, saveExecutionProgress } from "@/lib/domain/draft-ops";
import {
  caseStatus,
  currentStatus,
  executionCards,
  executionCounts,
  fillRunSteps,
  invalidResult,
  runnableSteps,
  runNote,
  runReport,
  runSignature,
} from "@/lib/domain/execution";
import type { Card, Draft, ExecutedStep, TestCaseStep } from "@/lib/domain/types";

const step = (description: string, linked: TestCaseStep[] = [], linkedTestCaseId: number | null = null): TestCaseStep => ({
  testStepId: null,
  position: 1,
  description,
  expectedResult: "",
  sampleData: "",
  precondition: "",
  linkedTestCaseId,
  linkedName: linkedTestCaseId ? "Login" : null,
  linkedSteps: linked,
});

const executed = (label: string, status: ExecutedStep["status"], actualResult = "", testStepId: number | null = null): ExecutedStep => ({
  label,
  testStepId,
  description: `Step ${label}`,
  expectedResult: "",
  status,
  actualResult,
});

function card(id: number, suggestion: Card["suggestion"], executionStatus = "Not Run"): Card {
  return {
    key: `1:${id}`,
    testSetId: 1,
    testCaseId: id + 1000,
    testSetTestCaseId: id,
    name: `Case ${id}`,
    tcId: null,
    executionStatus,
    executed: executionStatus !== "Not Run",
    suggestion,
    reason: "",
  };
}

const draft = (): Draft =>
  ({
    testSets: [{ testSetId: 1, cards: [card(1, "inScope"), card(2, "inScope", "Passed"), card(3, "outOfScope"), card(4, "blocked")] }],
    decisions: {},
    apply: emptyApplyState(),
  }) as unknown as Draft;

describe("execution steps", () => {
  it("runs the steps of a linked test case in place of the call", () => {
    const steps = runnableSteps([step("Open app"), step("", [step("Enter user"), step("Enter PIN")], 77), step("Check home")]);
    expect(steps.map((s) => s.label)).toEqual(["1", "2.1", "2.2", "3"]);
    expect(steps[1].linkedFrom).toBe("Login");
  });

  it("keeps a call whose steps were not loaded as one step", () => {
    expect(runnableSteps([step("", [], 77)]).map((s) => s.label)).toEqual(["1"]);
  });

  it("derives the case result from its steps", () => {
    expect(caseStatus(["passed", "passed"])).toBe("passed");
    expect(caseStatus(["passed", "notApplicable"])).toBe("passed");
    expect(caseStatus(["passed", null])).toBeNull();
    expect(caseStatus(["passed", "failed", null])).toBe("failed");
    expect(caseStatus(["caution", "blocked"])).toBe("blocked");
    expect(caseStatus(["notApplicable"])).toBeNull();
  });

  it("asks for what happened before saving a result that is not Passed", () => {
    expect(invalidResult("passed", "", [])).toBeNull();
    expect(invalidResult("failed", "", [])).toMatch(/Say what happened/);
    expect(invalidResult("failed", "Crashes on submit", [])).toBeNull();
    expect(invalidResult("failed", "", [executed("1", "passed"), executed("2", "failed", "Error 500")])).toBeNull();
  });

  it("rejects a result the steps do not support", () => {
    expect(invalidResult("passed", "", [executed("1", "passed"), executed("2", "failed", "x")])).toMatch(/steps say Failed/);
    expect(invalidResult("passed", "", [executed("1", "passed"), executed("2", null)])).toMatch(/Mark every step/);
  });
});

describe("run report", () => {
  it("summarises the failing step and lists every step", () => {
    const report = runReport({
      runner: "Reconciler",
      tester: "Ada",
      module: "Onboarding",
      draftName: "Sprint 3",
      status: "failed",
      comment: "",
      steps: [executed("1", "passed"), executed("2", "failed", "Spinner never stops"), executed("3", null)],
    });
    expect(report.message).toBe("Failed by Ada: step 2: Spinner never stops");
    expect(report.details).toContain("Step 2 - Failed");
    expect(report.details).toContain("  Actual: Spinner never stops");
    expect(report.details).toContain("Step 3 - Not run");
  });

  it("says when a case was passed as a whole", () => {
    const report = runReport({ runner: "R", tester: "", module: "M", draftName: "D", status: "passed", comment: "", steps: [] });
    expect(report.message).toBe("Passed: whole case");
    expect(report.details).toContain("without step results");
  });
});

describe("manual run steps", () => {
  const slots = (...ids: Array<[number, number]>) => ids.map(([testStepId, testCaseId]) => ({ testStepId, testCaseId }));
  const note = "Executed by Ada with R.";

  it("lays the marks onto Spira's steps by step ID and notes the deciding step", () => {
    const filled = fillRunSteps(slots([11, 1], [12, 1], [13, 1]), "failed", [
      executed("1", "passed", "", 11),
      executed("2", "failed", "Spinner never stops", 12),
      executed("3", null, "", 13),
    ], note);
    expect(filled?.map((f) => f.status)).toEqual(["passed", "failed", null]);
    expect(filled?.[1].actualResult).toBe(`Spinner never stops\n\n${note}`);
    expect(filled?.[0].actualResult).toBe("");
  });

  it("passes every step for a quick Pass and notes the last one", () => {
    const filled = fillRunSteps(slots([11, 1], [12, 1]), "passed", [], note);
    expect(filled?.map((f) => f.status)).toEqual(["passed", "passed"]);
    expect(filled?.[1].actualResult).toBe(note);
  });

  it("gives the steps of a call that was not loaded here the call's status", () => {
    const call: ExecutedStep = { ...executed("2", "passed", "", 20), linkedTestCaseId: 77 };
    const filled = fillRunSteps(slots([11, 1], [71, 77], [72, 77]), "passed", [executed("1", "passed", "", 11), call], note);
    expect(filled?.map((f) => f.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("matches a step that appears twice once per occurrence", () => {
    const filled = fillRunSteps(slots([71, 77], [71, 77]), "failed", [executed("1.1", "passed", "", 71), executed("2.1", "failed", "x", 71)], note);
    expect(filled?.map((f) => f.status)).toEqual(["passed", "failed"]);
  });

  it("refuses to save when Spira's steps would give a different result", () => {
    expect(fillRunSteps(slots([11, 1], [99, 1], [98, 1]), "failed", [executed("1", "passed", "", 11), executed("2", "failed", "x", 12)], note)).toBeNull();
    expect(fillRunSteps([], "passed", [], note)).toBeNull();
  });

  it("falls back to position when step IDs are missing and the counts agree", () => {
    const filled = fillRunSteps(slots([11, 1], [12, 1]), "blocked", [executed("1", "passed"), executed("2", "blocked", "No data")], note);
    expect(filled?.map((f) => f.status)).toEqual(["passed", "blocked"]);
  });

  it("signs the note so undo can tell the run is ours", () => {
    expect(runNote({ runner: "R", tester: "", comment: " Flaky " })).toBe(`Comment: Flaky\nExecuted by an unnamed tester ${runSignature("R")}`);
  });
});

describe("execution state", () => {
  it("executes only In Scope cards and counts their latest status", () => {
    const d = draft();
    expect(executionCards(d).map((c) => c.testSetTestCaseId)).toEqual([1, 2]);
    expect(executionCounts(executionCards(d), d.execution)).toMatchObject({ total: 2, passed: 1, notRun: 1 });
  });

  it("a Spira read replaces the status from the comparison", () => {
    const d = draft();
    recordExecutionStatus(d, [{ testSetId: 1, cases: [{ testSetTestCaseId: 2, testCaseId: 1002, statusId: 1, status: "Failed" }] }], "t");
    expect(currentStatus(card(2, "inScope", "Passed"), d.execution)).toBe("failed");
    expect(d.execution?.checkedAt).toBe("t");
  });

  it("keeps recorded runs for undo and clears the case's marks", () => {
    const d = draft();
    saveExecutionProgress(d, "1:1", { steps: { "1": { status: "passed", actualResult: "" } }, status: null, comment: "ok" });
    recordExecutionResults(
      d,
      [
        { testSetId: 1, testCaseId: 1001, testSetTestCaseId: 1, status: "passed", result: "recorded", testRunId: 55, message: null },
        { testSetId: 1, testCaseId: 1002, testSetTestCaseId: 2, status: "passed", result: "failed", testRunId: null, message: "HTTP 400" },
      ],
      [{ testSetTestCaseId: 1, comment: "ok" }],
      "Ada",
      new Date("2026-10-11T10:00:00Z"),
    );
    expect(d.execution?.runs).toEqual([
      { testSetId: 1, testCaseId: 1001, testSetTestCaseId: 1, status: "passed", testRunId: 55, at: "2026-10-11T10:00:00.000Z", tester: "Ada", comment: "ok" },
    ]);
    expect(d.execution?.progress["1:1"]).toBeUndefined();
    expect(d.execution?.spira["1:1"]).toEqual({ statusId: 2, status: "Passed" });
    expect(d.execution?.spira["1:2"]).toBeUndefined();

    recordExecutionUndo(d, [55]);
    expect(d.execution?.runs).toEqual([]);
  });
});
