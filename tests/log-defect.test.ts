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

const card = (id: number): Card => ({
  key: `1:${id}`,
  testSetId: 1,
  testCaseId: id + 1000,
  testSetTestCaseId: id,
  name: `Case ${id}`,
  tcId: null,
  executionStatus: "Not Run",
  executed: false,
  suggestion: id === 3 ? "outOfScope" : "inScope",
  reason: "",
});

const run = (id: number) => ({ testRunId: 900 + id, testCaseId: id + 1000, testSetId: 1, testSetTestCaseId: id });

function request(runs: Array<ReturnType<typeof run>>) {
  const comparison = sealComparison(ctx, {
    testSetId: 1,
    testSetName: "TX125",
    platform: "iOS" as Platform,
    comparedAt: "2026-10-11T08:00:00Z",
    cards: [1, 2, 3].map(card),
    missingFromSpira: [],
    baselineMembership: [1, 2, 3],
  });
  return {
    context: ctx,
    testSets: [comparison],
    decisions: {},
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

  it("refuses runs of cases that are not In Scope on the board, or not on it", async () => {
    await expect(logDefect(request([run(3)]))).rejects.toThrow(/not In Scope/);
    await expect(logDefect(request([{ ...run(1), testCaseId: 4242 }]))).rejects.toThrow(/not on this board/);
    await expect(logDefect(request([run(1), run(1)]))).rejects.toThrow(/twice/);
    expect(spira.getRecordedRunSteps).not.toHaveBeenCalled();
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
