import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Platform, WorkflowContext } from "@/lib/domain/types";

vi.mock("server-only", () => ({}));

const spira = vi.hoisted(() => ({
  getRecordedRunSteps: vi.fn(),
  createIncident: vi.fn(),
  deleteLoggedIncident: vi.fn(),
}));

vi.mock("@/lib/server/spira", async (importOriginal) => ({ ...(await importOriginal<object>()), ...spira }));

const { SpiraError } = await import("@/lib/server/spira");
const { sealComparison } = await import("@/lib/server/seal");
const { logDefect, undoDefect } = await import("@/lib/server/workflow");

const ctx: WorkflowContext = { projectId: 24, releaseId: 5, module: "Onboarding" };
const homeCtx: WorkflowContext = { projectId: 24, releaseId: 6, module: "Home Screen" };

/** Test set 1 (Onboarding) has cases 1-3, test set 2 (Home Screen) cases 4-5; 3 and 5 are Out of Scope. */
const card = (testSetId: number, id: number): Card => ({
  key: `${testSetId}:${id}`,
  testSetId,
  testCaseId: id + 1000,
  testSetTestCaseId: id,
  name: `Case ${id}`,
  tcId: null,
  executionStatus: "Not Run",
  executed: false,
  suggestion: id === 3 || id === 5 ? "outOfScope" : "inScope",
  reason: "",
});

const run = (id: number, board = 0) => ({ board, testRunId: 900 + id, testCaseId: id + 1000, testSetId: board === 0 ? 1 : 2, testSetTestCaseId: id });

function board(context: WorkflowContext, testSetId: number, ids: number[], decisions: Record<string, "defects" | "inScope"> = {}) {
  const comparison = sealComparison(context, {
    testSetId,
    testSetName: `TX${testSetId}`,
    platform: "iOS" as Platform,
    comparedAt: "2026-10-11T08:00:00Z",
    cards: ids.map((id) => card(testSetId, id)),
    missingFromSpira: [],
    baselineMembership: ids,
  });
  return { context, testSets: [comparison], decisions };
}

function request(runs: Array<ReturnType<typeof run>>, boards = [board(ctx, 1, [1, 2, 3])]) {
  return {
    boards,
    defect: { name: "Login: Continue enabled with empty phone", description: "Continue is enabled.", typeId: 1, priorityId: 2, severityId: 3 },
    runs,
  };
}

const steps = (testRunId: number, over: Partial<{ testCaseId: number; ours: boolean; failedStepIds: number[] }> = {}) => ({
  testRunId,
  testCaseId: testRunId - 900 + 1000,
  releaseId: 5,
  ours: true,
  failedStepIds: [testRunId * 10],
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(spira)) fn.mockReset();
  spira.getRecordedRunSteps.mockImplementation(async (_p: number, testRunId: number) => steps(testRunId));
  spira.createIncident.mockResolvedValue(77);
});

describe("logDefect", () => {
  it("links the incident to the first failed step of each run, with the draft's release", async () => {
    const out = await logDefect(request([run(1), run(2)]));
    expect(out).toEqual({
      incidentId: 77,
      linked: [
        { testRunId: 901, testRunStepId: 9010 },
        { testRunId: 902, testRunStepId: 9020 },
      ],
      unlinked: [],
    });
    expect(spira.createIncident).toHaveBeenCalledWith(24, expect.objectContaining({ releaseId: 5, testRunStepIds: [9010, 9020], severityId: 3, name: "Login: Continue enabled with empty phone" }));
  });

  it("leaves out runs that are not this app's, belong to another case or have no failed step", async () => {
    spira.getRecordedRunSteps.mockImplementation(async (_p: number, testRunId: number) =>
      testRunId === 902 ? steps(testRunId, { ours: false }) : steps(testRunId, { failedStepIds: [] }),
    );
    await expect(logDefect(request([run(1), run(2)]))).rejects.toThrow(/No run could be linked/);
    expect(spira.createIncident).not.toHaveBeenCalled();

    spira.getRecordedRunSteps.mockImplementation(async (_p: number, testRunId: number) => (testRunId === 902 ? steps(testRunId, { testCaseId: 5555 }) : steps(testRunId)));
    const out = await logDefect(request([run(1), run(2)]));
    expect(out.linked).toEqual([{ testRunId: 901, testRunStepId: 9010 }]);
    expect(out.unlinked).toEqual([{ testRunId: 902, message: "Test run 902 was not recorded here for TC1002." }]);
  });

  it("reports a run Spira could not read and links the rest", async () => {
    spira.getRecordedRunSteps.mockImplementation(async (_p: number, testRunId: number) => {
      if (testRunId === 901) throw new SpiraError("Spira did not answer.", 504);
      return steps(testRunId);
    });
    const out = await logDefect(request([run(1), run(2)]));
    expect(out.unlinked).toEqual([{ testRunId: 901, message: "Spira did not answer." }]);
    expect(out.linked).toHaveLength(1);
  });

  it("refuses runs of cases that are not In Scope or in Defects on the board, or not on it", async () => {
    await expect(logDefect(request([run(3)]))).rejects.toThrow(/not In Scope or in Defects/);
    await expect(logDefect(request([{ ...run(1), testCaseId: 4242 }]))).rejects.toThrow(/not on the Onboarding board/);
    await expect(logDefect(request([run(1), run(1)]))).rejects.toThrow(/twice/);
    await expect(logDefect(request([run(4, 1)]))).rejects.toThrow(/names a module that was not sent/);
    expect(spira.getRecordedRunSteps).not.toHaveBeenCalled();
  });

  it("links one incident to runs in several modules, including an Out of Scope case moved to Defects", async () => {
    const boards = [board(ctx, 1, [1, 2, 3]), board(homeCtx, 2, [4, 5], { "2:5": "defects" })];
    const out = await logDefect(request([run(4, 1), run(5, 1), run(1)], boards));
    expect(out.linked.map((l) => l.testRunId)).toEqual([904, 905, 901]);
    expect(spira.createIncident).toHaveBeenCalledWith(24, expect.objectContaining({ releaseId: 6, testRunStepIds: [9040, 9050, 9010] }));
  });

  it("refuses modules from different Spira projects", async () => {
    const other = board({ ...homeCtx, projectId: 25 }, 2, [4, 5]);
    await expect(logDefect(request([run(1), run(4, 1)], [board(ctx, 1, [1, 2, 3]), other]))).rejects.toThrow(/same Spira project/);
  });
});

describe("undoDefect", () => {
  it("treats an incident already gone from Spira as undone", async () => {
    spira.deleteLoggedIncident.mockRejectedValue(new SpiraError("not found", 502, 404));
    await expect(undoDefect({ projectId: 24, incidentId: 77 })).resolves.toEqual({ ok: true, message: "Already deleted in Spira." });
  });

  it("passes on a refusal to delete an incident the app did not log", async () => {
    spira.deleteLoggedIncident.mockRejectedValue(new SpiraError("Incident 77 was not logged by this app, so it was not deleted.", 409));
    await expect(undoDefect({ projectId: 24, incidentId: 77 })).rejects.toThrow(/not logged by this app/);
  });
});
