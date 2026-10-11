import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Platform, WorkflowContext } from "@/lib/domain/types";

vi.mock("server-only", () => ({}));

const spira = vi.hoisted(() => ({
  getTestSet: vi.fn(),
  getTestSetCases: vi.fn(),
  createManualRunShells: vi.fn(),
  saveManualRuns: vi.fn(),
  recordTestRun: vi.fn(),
}));

vi.mock("@/lib/server/spira", async (importOriginal) => ({ ...(await importOriginal<object>()), ...spira }));

const { SpiraError } = await import("@/lib/server/spira");
const { sealComparison } = await import("@/lib/server/seal");
const { recordExecutions } = await import("@/lib/server/workflow");

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
  suggestion: "inScope",
  reason: "",
});

const shell = (testCaseId: number) => ({
  raw: { TestCaseId: testCaseId, TestRunSteps: [{ TestStepId: testCaseId * 10, TestCaseId: testCaseId }, { TestStepId: testCaseId * 10 + 1, TestCaseId: testCaseId }] },
  steps: [
    { testStepId: testCaseId * 10, testCaseId },
    { testStepId: testCaseId * 10 + 1, testCaseId },
  ],
});

function request(ids: number[]) {
  const cards = [1, 2, 3].map(card);
  const comparison = sealComparison(ctx, {
    testSetId: 1,
    testSetName: "TX125",
    platform: "ios" as Platform,
    comparedAt: "2026-10-11T08:00:00Z",
    cards,
    missingFromSpira: [],
    baselineMembership: [1, 2, 3],
  });
  return {
    context: ctx,
    testSets: [comparison],
    decisions: {},
    draftName: "Sprint 3",
    tester: "Ada",
    batch: {
      testSetId: 1,
      cases: ids.map((id) => ({ testCaseId: id + 1000, testSetTestCaseId: id, status: "passed" as const, comment: "", steps: [] })),
    },
  };
}

beforeEach(() => {
  for (const fn of Object.values(spira)) fn.mockReset();
  spira.getTestSet.mockResolvedValue({ testSetId: 1, name: "TX125", releaseId: 5 });
  spira.getTestSetCases.mockResolvedValue(
    [1, 2, 3].map((id) => ({ testSetTestCaseId: id, testCaseId: id + 1000, name: `Case ${id}`, executionStatus: "Not Run", executionStatusId: 3, executed: false, customText: [] })),
  );
  spira.createManualRunShells.mockImplementation(async (_p: number, ids: number[]) => ids.map(shell));
});

describe("recording execution results in batches", () => {
  it("prepares and saves the whole batch in one call each, with every step passed", async () => {
    spira.saveManualRuns.mockResolvedValue([501, 502, 503]);
    const { results } = await recordExecutions(request([1, 2, 3]));
    expect(spira.createManualRunShells).toHaveBeenCalledTimes(1);
    expect(spira.createManualRunShells).toHaveBeenCalledWith(24, [1001, 1002, 1003], 5);
    expect(spira.saveManualRuns).toHaveBeenCalledTimes(1);
    const runs = spira.saveManualRuns.mock.calls[0][1];
    expect(runs).toHaveLength(3);
    expect(runs[0].steps.map((s: { executionStatusId: number }) => s.executionStatusId)).toEqual([2, 2]);
    expect(runs[0].steps[1].actualResult).toContain("Executed by Ada");
    expect(results.map((r) => [r.result, r.testRunId])).toEqual([
      ["recorded", 501],
      ["recorded", 502],
      ["recorded", 503],
    ]);
  });

  it("saves case by case when Spira rejects the batch, so one bad case does not hold back the rest", async () => {
    spira.saveManualRuns
      .mockRejectedValueOnce(new SpiraError("Spira returned HTTP 400", 502, 400))
      .mockResolvedValueOnce([601])
      .mockRejectedValueOnce(new SpiraError("Spira returned HTTP 400: bad step", 502, 400))
      .mockResolvedValueOnce([603]);
    const { results } = await recordExecutions(request([1, 2, 3]));
    expect(spira.saveManualRuns).toHaveBeenCalledTimes(4);
    expect(results.map((r) => r.result)).toEqual(["recorded", "failed", "recorded"]);
    expect(results[1].message).toMatch(/bad step/);
  });

  it("does not save again when Spira did not answer, since the batch may have been saved", async () => {
    spira.saveManualRuns.mockRejectedValueOnce(new SpiraError("Spira did not answer within 30s", 504));
    const { results } = await recordExecutions(request([1, 2]));
    expect(spira.saveManualRuns).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.result === "failed")).toBe(true);
  });

  it("skips a case that left the test set and does not prepare a run for it", async () => {
    spira.getTestSetCases.mockResolvedValue([{ testSetTestCaseId: 1, testCaseId: 1001, name: "Case 1", executionStatus: "Not Run", executionStatusId: 3, executed: false, customText: [] }]);
    spira.saveManualRuns.mockResolvedValue([701]);
    const { results } = await recordExecutions(request([1, 2]));
    expect(spira.createManualRunShells).toHaveBeenCalledWith(24, [1001], 5);
    expect(results.map((r) => r.result)).toEqual(["recorded", "skipped"]);
  });
});
