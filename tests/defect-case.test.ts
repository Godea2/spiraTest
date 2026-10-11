import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Draft, Platform, TestSetComparison, WorkflowContext } from "@/lib/domain/types";

vi.mock("server-only", () => ({}));

const spira = vi.hoisted(() => ({
  getTestCaseFolderId: vi.fn(),
  createTestCase: vi.fn(),
  addTestStep: vi.fn(),
  addToTestSet: vi.fn(),
  removeFromTestSet: vi.fn(),
  deleteCreatedTestCase: vi.fn(),
}));

vi.mock("@/lib/server/spira", async (importOriginal) => ({ ...(await importOriginal<object>()), ...spira }));

const { SpiraError } = await import("@/lib/server/spira");
const { sealComparison } = await import("@/lib/server/seal");
const { createDefectCase, deleteDefectCase } = await import("@/lib/server/workflow");
const { emptyApplyState, recordCleanCompletion, recordComparison } = await import("@/lib/domain/draft-ops");
const { newCaseTargets } = await import("@/lib/client/defects");
const { testCaseSignature } = await import("@/lib/domain/defects");

const ctx: WorkflowContext = { projectId: 24, releaseId: 5, module: "Payments" };

const card = (testSetId: number, id: number, suggestion: Card["suggestion"] = "inScope"): Card => ({
  key: `${testSetId}:${id}`,
  testSetId,
  testCaseId: id + 1000,
  testSetTestCaseId: id,
  name: `Case ${id}`,
  tcId: null,
  executionStatus: "Not Run",
  executed: false,
  suggestion,
  reason: "",
});

const comparison = (testSetId: number, cards: Card[], platform: Platform = "iOS"): TestSetComparison => ({
  testSetId,
  testSetName: `Payments ${platform}`,
  platform,
  comparedAt: "2026-10-11T09:00:00.000Z",
  cards,
  missingFromSpira: [],
  baselineMembership: cards.map((c) => c.testSetTestCaseId),
  seal: "",
});

function board(context: WorkflowContext, testSetId: number, ids: number[]) {
  return { context, testSets: [sealComparison(context, comparison(testSetId, ids.map((id) => card(testSetId, id))))], decisions: {} };
}

const testCase = {
  name: "Recurring payments: change the frequency",
  description: "Covers the Choose frequency sheet.",
  steps: [
    { description: "Open a recurring payment", expectedResult: "Its details show" },
    { description: "Tap Choose frequency", expectedResult: "Weekly, monthly and yearly are listed" },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(spira)) fn.mockReset();
  spira.getTestCaseFolderId.mockResolvedValue(31);
  spira.createTestCase.mockResolvedValue(5000);
  spira.addTestStep.mockResolvedValue(undefined);
  spira.addToTestSet.mockImplementation(async (_p: number, testSetId: number) => testSetId * 100);
  spira.removeFromTestSet.mockResolvedValue(undefined);
  spira.deleteCreatedTestCase.mockResolvedValue(undefined);
});

describe("createDefectCase", () => {
  it("creates the signed case in its test set's folder, adds the steps in order and maps it into each set", async () => {
    const boards = [board(ctx, 1, [1, 2]), board({ ...ctx, module: "Transfers" }, 2, [3])];
    const out = await createDefectCase({ boards, testCase, targets: [{ board: 0, testSetId: 1 }, { board: 1, testSetId: 2 }] });

    expect(out).toEqual({ testCaseId: 5000, memberships: [{ testSetId: 1, testSetTestCaseId: 100 }, { testSetId: 2, testSetTestCaseId: 200 }] });
    expect(spira.getTestCaseFolderId).toHaveBeenCalledWith(24, 1001);
    expect(spira.createTestCase).toHaveBeenCalledWith(24, {
      name: testCase.name,
      description: expect.stringContaining(testCaseSignature("Spira Test Set Reconciler")),
      folderId: 31,
    });
    expect(spira.addTestStep.mock.calls.map((c) => c[2].position)).toEqual([1, 2]);
  });

  it("refuses test sets that are not on the boards sent, twice over, or from another project", async () => {
    const boards = [board(ctx, 1, [1])];
    await expect(createDefectCase({ boards, testCase, targets: [{ board: 0, testSetId: 9 }] })).rejects.toThrow(/not on the board/);
    await expect(createDefectCase({ boards, testCase, targets: [{ board: 0, testSetId: 1 }, { board: 0, testSetId: 1 }] })).rejects.toThrow(/twice/);
    const mixed = [board(ctx, 1, [1]), board({ ...ctx, projectId: 25 }, 2, [3])];
    await expect(createDefectCase({ boards: mixed, testCase, targets: [{ board: 0, testSetId: 1 }] })).rejects.toThrow(/same Spira project/);
    expect(spira.createTestCase).not.toHaveBeenCalled();
  });

  it("refuses a board whose comparison was not sealed by the server", async () => {
    const forged = { context: ctx, testSets: [comparison(1, [card(1, 1)])], decisions: {} };
    await expect(createDefectCase({ boards: [forged], testCase, targets: [{ board: 0, testSetId: 1 }] })).rejects.toThrow();
    expect(spira.createTestCase).not.toHaveBeenCalled();
  });

  it("still creates the case when its folder cannot be read", async () => {
    spira.getTestCaseFolderId.mockRejectedValue(new SpiraError("Spira did not answer.", 504));
    await createDefectCase({ boards: [board(ctx, 1, [1])], testCase, targets: [{ board: 0, testSetId: 1 }] });
    expect(spira.createTestCase).toHaveBeenCalledWith(24, expect.objectContaining({ folderId: null }));
  });

  it("removes what it created when a later write fails, and says so", async () => {
    spira.addToTestSet.mockImplementation(async (_p: number, testSetId: number) => {
      if (testSetId === 2) throw new SpiraError("Spira refused the change.", 502, 403);
      return 100;
    });
    const boards = [board(ctx, 1, [1]), board({ ...ctx, module: "Transfers" }, 2, [3])];
    await expect(createDefectCase({ boards, testCase, targets: [{ board: 0, testSetId: 1 }, { board: 1, testSetId: 2 }] })).rejects.toThrow(
      /Spira refused the change\. Nothing was left in Spira\./,
    );
    expect(spira.removeFromTestSet).toHaveBeenCalledWith(24, 1, 100);
    expect(spira.deleteCreatedTestCase).toHaveBeenCalledWith(24, 5000);
  });

  it("lists anything it could not remove after a failure", async () => {
    spira.addTestStep.mockRejectedValue(new SpiraError("Spira did not answer.", 504));
    spira.deleteCreatedTestCase.mockRejectedValue(new SpiraError("Spira did not answer.", 504));
    await expect(createDefectCase({ boards: [board(ctx, 1, [1])], testCase, targets: [{ board: 0, testSetId: 1 }] })).rejects.toThrow(
      /delete them in Spira: test case 5000/,
    );
    expect(spira.addToTestSet).not.toHaveBeenCalled();
  });
});

describe("deleteDefectCase", () => {
  it("deletes the case, then its memberships, tolerating ones already gone", async () => {
    spira.removeFromTestSet.mockRejectedValueOnce(new SpiraError("not found", 502, 404));
    const out = await deleteDefectCase({ projectId: 24, testCaseId: 5000, memberships: [{ testSetId: 1, testSetTestCaseId: 100 }, { testSetId: 2, testSetTestCaseId: 200 }] });
    expect(out).toEqual({ ok: true, message: null });
    expect(spira.removeFromTestSet).toHaveBeenCalledTimes(2);
  });

  it("treats a case already gone as undone and passes on a refusal to delete one it did not create", async () => {
    spira.deleteCreatedTestCase.mockRejectedValueOnce(new SpiraError("not found", 502, 404));
    await expect(deleteDefectCase({ projectId: 24, testCaseId: 5000, memberships: [] })).resolves.toEqual({ ok: true, message: "Already deleted in Spira." });

    spira.deleteCreatedTestCase.mockRejectedValueOnce(new SpiraError("Test case 5000 was not created by this app, so it was not deleted.", 409));
    await expect(deleteDefectCase({ projectId: 24, testCaseId: 5000, memberships: [] })).rejects.toThrow(/not created by this app/);
    expect(spira.removeFromTestSet).not.toHaveBeenCalled();
  });
});

const draftWith = (id: string, sets: TestSetComparison[], over: Partial<Draft> = {}): Draft =>
  ({
    id,
    name: id,
    module: "Payments",
    projectId: 24,
    status: "draft",
    createdAt: "",
    updatedAt: "2026-10-10T00:00:00.000Z",
    testSetIds: sets.map((s) => s.testSetId),
    testSets: sets,
    compareErrors: {},
    decisions: {},
    history: [],
    apply: emptyApplyState(),
    ...over,
  }) as unknown as Draft;

describe("placing a newly added case on the board", () => {
  const matches = { at: "2026-10-11T10:00:00.000Z", ok: true, sets: [{ testSetId: 1, ok: true, stillPresent: [], unexpectedlyRemoved: [] }] };

  it("puts the new case in Defects instead of Out of Scope, so a completed draft stays completed", () => {
    const draft = draftWith("d1", [comparison(1, [card(1, 1)])]);
    expect(recordCleanCompletion(draft, matches)).toBe(true);

    recordComparison(draft, comparison(1, [card(1, 1), card(1, 77, "outOfScope")]), { "1:77": "defects" });
    expect(draft.decisions["1:77"]).toBe("defects");
    expect(draft.status).toBe("applied");
  });

  it("without a placement the new case is Out of Scope and the draft reopens", () => {
    const draft = draftWith("d1", [comparison(1, [card(1, 1)])]);
    recordCleanCompletion(draft, matches);
    recordComparison(draft, comparison(1, [card(1, 1), card(1, 77, "outOfScope")]));
    expect(draft.decisions["1:77"]).toBeUndefined();
    expect(draft.status).toBe("draft");
  });
});

describe("newCaseTargets", () => {
  it("lists each test set once, from a completed draft first, sorted by module and name", () => {
    const older = draftWith("old", [comparison(1, [], "iOS"), comparison(2, [], "Android")], { status: "applied", updatedAt: "2026-10-01T00:00:00.000Z" });
    const newer = draftWith("new", [comparison(1, [], "iOS")], { updatedAt: "2026-10-11T00:00:00.000Z" });
    const transfers = draftWith("tr", [{ ...comparison(3, [], "iOS"), testSetName: "Transfers iOS" }], { module: "Transfers" });

    const targets = newCaseTargets([newer, transfers, older]);
    expect(targets.map((t) => t.key)).toEqual(["old|2", "old|1", "tr|3"]);
    expect(targets[0]).toMatchObject({ module: "Payments", testSetName: "Payments Android", platform: "Android" });
  });
});
