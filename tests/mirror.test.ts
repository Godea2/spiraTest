import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Column, DefectRecord, Draft, ExecutionRun, Platform, RunDetail, TestSetComparison, WorkflowContext } from "@/lib/domain/types";

vi.mock("server-only", () => ({}));

const spira = vi.hoisted(() => ({
  getMembership: vi.fn(),
  addToTestSet: vi.fn(),
}));

vi.mock("@/lib/server/spira", async (importOriginal) => ({ ...(await importOriginal<object>()), ...spira }));

const { SpiraError } = await import("@/lib/server/spira");
const { sealComparison } = await import("@/lib/server/seal");
const { addCasesFromSource } = await import("@/lib/server/workflow");
const { emptyApplyState } = await import("@/lib/domain/draft-ops");
const { runNote, RUNNER_NAME } = await import("@/lib/domain/execution");
const mirror = await import("@/lib/domain/mirror");

const ctx: WorkflowContext = { projectId: 24, releaseId: 5, module: "Payments" };

/** Membership IDs are unique per test set; test case IDs are shared between platforms. */
const card = (testSetId: number, membership: number, testCaseId: number, suggestion: Column = "inScope", executionStatus = "Not Run"): Card => ({
  key: `${testSetId}:${membership}`,
  testSetId,
  testCaseId,
  testSetTestCaseId: membership,
  name: `Case ${testCaseId}`,
  tcId: null,
  executionStatus,
  executed: executionStatus !== "Not Run",
  suggestion,
  reason: "",
});

const comparison = (testSetId: number, cards: Card[], platform: Platform): TestSetComparison => ({
  testSetId,
  testSetName: `Payments-${platform}`,
  platform,
  comparedAt: "2026-10-12T09:00:00.000Z",
  cards,
  missingFromSpira: [],
  baselineMembership: cards.map((c) => c.testSetTestCaseId),
  seal: "",
});

function draft(id: string, sets: TestSetComparison[], decisions: Record<string, Column> = {}, extra: Partial<Draft> = {}): Draft {
  return {
    id,
    name: id,
    module: "Payments",
    projectId: 24,
    releaseId: 5,
    releaseLabel: "",
    status: "applied",
    createdAt: "",
    updatedAt: "",
    source: { fileName: "scope.xlsx", sheets: [] } as unknown as Draft["source"],
    rows: [],
    testSetIds: sets.map((s) => s.testSetId),
    testSets: sets.map((s) => sealComparison(ctx, s)),
    compareErrors: {},
    decisions,
    history: [],
    apply: emptyApplyState(),
    ...extra,
  };
}

// iOS (TX:126): 1001 In Scope, 1002 Defects, 1003 Blocked, 1004 Out of Scope, 1009 a defect-created case in Defects.
const ios = () =>
  draft(
    "ios",
    [comparison(126, [card(126, 1, 1001), card(126, 2, 1002), card(126, 3, 1003, "blocked"), card(126, 4, 1004), card(126, 5, 1009, "outOfScope")], "iOS")],
    { "126:2": "defects", "126:4": "outOfScope", "126:5": "defects" },
  );
// Android (TX:127): holds 1001, 1002, 1003, 1004 and an extra 1050, but not 1009.
const android = () =>
  draft("android", [comparison(127, [card(127, 11, 1001), card(127, 12, 1002), card(127, 13, 1003), card(127, 14, 1004), card(127, 15, 1050)], "Android")]);
const pairs = [{ sourceTestSetId: 126, targetTestSetId: 127 }];

describe("pushTarget and counterpartSets", () => {
  it("pushes only single-platform drafts between iOS and Android", () => {
    expect(mirror.pushTarget(["iOS"])).toBe("Android");
    expect(mirror.pushTarget(["Android"])).toBe("iOS");
    expect(mirror.pushTarget(["iOS", "Android"])).toBeNull();
    expect(mirror.pushTarget(["Web"])).toBeNull();
  });

  it("finds the other platform's set for the module, in the source's release first", () => {
    const all = [
      { testSetId: 126, name: "Payments-iOS", releaseId: 9, releaseVersion: "1.0.0.0001" },
      { testSetId: 27, name: "Payments-Android", releaseId: 8, releaseVersion: "1.0.0.0000" },
      { testSetId: 127, name: "Payments-Android", releaseId: 9, releaseVersion: "1.0.0.0001" },
      { testSetId: 134, name: "Transfers-Android", releaseId: 9, releaseVersion: "1.0.0.0001" },
      { testSetId: 135, name: "Payments-iOS", releaseId: 9, releaseVersion: "1.0.0.0001" },
    ];
    expect(mirror.counterpartSets(all, { testSetId: 126, testSetName: "Payments-iOS" }, "Payments", "Android").map((t) => t.testSetId)).toEqual([127, 27]);
  });
});

describe("planMirror", () => {
  it("keeps each kept case in the source's column, removes the rest, and lists kept cases to add", () => {
    const plan = mirror.planMirror(ios(), android(), pairs);
    expect(plan.moves).toEqual([
      { key: "127:11", to: "inScope" },
      { key: "127:12", to: "defects" },
      { key: "127:13", to: "blocked" },
      { key: "127:14", to: "outOfScope" },
      { key: "127:15", to: "outOfScope" },
    ]);
    expect(plan.sets[0].add).toEqual([{ testCaseId: 1009, name: "Case 1009", column: "defects" }]);
    expect(plan.counts).toEqual({ inScope: 1, defects: 1, blocked: 1, remove: 2, add: 1 });
  });

  it("matches a case held twice as often as the source keeps it", () => {
    const source = draft("ios", [comparison(126, [card(126, 1, 1001), card(126, 2, 1001)], "iOS")]);
    const target = draft("android", [comparison(127, [card(127, 11, 1001)], "Android")]);
    const plan = mirror.planMirror(source, target, pairs);
    expect(plan.moves).toEqual([{ key: "127:11", to: "inScope" }]);
    expect(plan.sets[0].add).toEqual([{ testCaseId: 1001, name: "Case 1001", column: "inScope" }]);
  });

  it("reports whether the target board already matches", () => {
    const plan = mirror.planMirror(ios(), android(), pairs);
    expect(mirror.mirrorMatches(plan, {})).toBe(false);
    const decisions = Object.fromEntries(plan.moves.map((m) => [m.key, m.to]));
    expect(mirror.mirrorMatches({ ...plan, counts: { ...plan.counts, add: 0 } }, decisions)).toBe(true);
    expect(mirror.mirrorMatches(plan, decisions)).toBe(false);
  });
});

describe("planResults", () => {
  const run = (testSetTestCaseId: number, status: ExecutionRun["status"], testRunId: number, at: string): ExecutionRun => ({
    testSetId: 126,
    testCaseId: 0,
    testSetTestCaseId,
    status,
    testRunId,
    at,
    tester: "Ada",
    comment: status === "passed" ? "" : "Crashes on submit",
  });

  it("copies the latest source result to cases with none, and leaves the rest", () => {
    const source = ios();
    source.execution = {
      runs: [run(1, "failed", 400, "2026-10-01"), run(1, "passed", 401, "2026-10-02"), run(2, "failed", 402, "2026-10-02")],
      progress: {},
      spira: { "126:1": { statusId: 2, status: "Passed" }, "126:2": { statusId: 1, status: "Failed" }, "126:5": { statusId: null, status: "Not Run" } },
      checkedAt: null,
    };
    const target = android();
    target.testSets[0].cards.push(card(127, 16, 1009));
    target.decisions = { "127:12": "defects", "127:13": "blocked", "127:14": "outOfScope", "127:15": "outOfScope", "127:16": "defects" };
    const plan = mirror.planResults(source, target, pairs);
    expect(plan.copy.map((c) => [c.card.key, c.status, c.run?.testRunId ?? null])).toEqual([
      ["127:11", "passed", 401],
      ["127:12", "failed", 402],
    ]);
    expect(plan.notRunOnSource.map((c) => c.key)).toEqual(["127:16"]);

    target.execution = { runs: [], progress: {}, spira: { "127:11": { statusId: 2, status: "Passed" } }, checkedAt: null };
    expect(mirror.planResults(source, target, pairs).alreadyDone.map((c) => c.key)).toEqual(["127:11"]);
  });
});

describe("copying a run", () => {
  const note = runNote({ runner: RUNNER_NAME, tester: "Ada", comment: "Crashes on submit\nevery time" });

  it("strips the app's note from an actual result", () => {
    expect(mirror.stripRunNote(`The app closes\n\n${note}`)).toBe("The app closes");
    expect(mirror.stripRunNote(note)).toBe("");
    expect(mirror.stripRunNote("Nothing added")).toBe("Nothing added");
  });

  it("copies the steps when they give the same result, matched by test step ID", () => {
    const detail: RunDetail = {
      testRunId: 402,
      testCaseId: 1002,
      statusId: 1,
      steps: [
        { testStepId: 71, statusId: 2, actualResult: "" },
        { testStepId: 72, statusId: 1, actualResult: `Spinner never stops\n\n${note}` },
        { testStepId: 73, statusId: 3, actualResult: "" },
      ],
    };
    const steps = mirror.copiedSteps(detail, "failed");
    expect(steps.map((s) => [s.testStepId, s.status, s.actualResult])).toEqual([
      [71, "passed", ""],
      [72, "failed", "Spinner never stops"],
      [73, null, ""],
    ]);
    expect(mirror.copiedSteps(detail, "passed")).toEqual([]);
    expect(mirror.copiedSteps(undefined, "failed")).toEqual([]);
  });

  it("names the source run and its defects, with the source comment when the steps are not copied", () => {
    const source = card(126, 2, 1002);
    const copy = {
      card: card(127, 12, 1002),
      source,
      sourceSetName: "Payments-iOS",
      status: "failed" as const,
      run: { testSetId: 126, testCaseId: 1002, testSetTestCaseId: 2, status: "failed" as const, testRunId: 402, at: "", tester: "Ada", comment: "Crashes on submit" },
    };
    expect(mirror.copyComment(copy, "iOS", [264, 270], true)).toBe("Same result as on iOS: Payments-iOS (TX:126), test run TR:402. Defects: IN:264, IN:270.");
    const input = mirror.copyInput(copy, "iOS", [264], undefined);
    expect(input).toMatchObject({ testCaseId: 1002, testSetTestCaseId: 12, status: "failed", steps: [] });
    expect(input.comment).toBe("Same result as on iOS: Payments-iOS (TX:126), test run TR:402. Defect: IN:264. iOS comment: Crashes on submit");
  });

  it("finds the incidents logged here for the source case", () => {
    const records = [
      { incidentId: 264, cases: [{ draftId: "ios", testSetId: 126, testSetTestCaseId: 2 }] },
      { incidentId: null, cases: [{ draftId: "ios", testSetId: 126, testSetTestCaseId: 2 }] },
      { incidentId: 300, cases: [{ draftId: "other", testSetId: 126, testSetTestCaseId: 2 }] },
    ] as unknown as DefectRecord[];
    expect(mirror.defectsFor(records, "ios", card(126, 2, 1002))).toEqual([264]);
  });
});

describe("addCasesFromSource", () => {
  const boards = () => {
    const source = ios();
    const target = android();
    return {
      target: { context: ctx, testSets: target.testSets },
      source: { context: ctx, testSets: source.testSets, decisions: source.decisions },
    };
  };

  beforeEach(() => {
    spira.getMembership.mockReset().mockResolvedValue(new Map([[11, 1001], [12, 1002], [13, 1003], [14, 1004], [15, 1050]]));
    spira.addToTestSet.mockReset().mockImplementation(async (_p: number, _s: number, testCaseId: number) => testCaseId + 9000);
  });

  it("adds a case the source keeps, one at a time", async () => {
    const out = await addCasesFromSource({ ...boards(), testSetId: 127, sourceTestSetId: 126, testCaseIds: [1009] });
    expect(out.results).toEqual([{ testCaseId: 1009, result: "added", testSetTestCaseId: 10009, message: null }]);
    expect(spira.addToTestSet).toHaveBeenCalledWith(24, 127, 1009);
  });

  it("refuses a case the source does not keep, or a board whose seal does not verify", async () => {
    await expect(addCasesFromSource({ ...boards(), testSetId: 127, sourceTestSetId: 126, testCaseIds: [1004] })).rejects.toThrow(/not kept/);
    const tampered = boards();
    tampered.source.testSets[0] = { ...tampered.source.testSets[0], cards: [...tampered.source.testSets[0].cards, card(126, 6, 1060)] };
    await expect(addCasesFromSource({ ...tampered, testSetId: 127, sourceTestSetId: 126, testCaseIds: [1060] })).rejects.toThrow();
    await expect(addCasesFromSource({ ...boards(), testSetId: 126, sourceTestSetId: 126, testCaseIds: [1009] })).rejects.toThrow(/itself/);
    expect(spira.addToTestSet).not.toHaveBeenCalled();
  });

  it("skips a case already on the board or already added in Spira, and reports a failed add without retrying", async () => {
    spira.getMembership.mockResolvedValue(new Map([[11, 1001], [99, 1009]]));
    const out = await addCasesFromSource({ ...boards(), testSetId: 127, sourceTestSetId: 126, testCaseIds: [1001, 1009] });
    expect(out.results.map((r) => [r.testCaseId, r.result, r.message])).toEqual([
      [1001, "skipped", "Already in the test set."],
      [1009, "skipped", "Already added in Spira since the last compare."],
    ]);

    spira.getMembership.mockResolvedValue(new Map());
    spira.addToTestSet.mockRejectedValueOnce(new SpiraError("Spira answered 500", 502));
    const failed = await addCasesFromSource({ ...boards(), testSetId: 127, sourceTestSetId: 126, testCaseIds: [1009] });
    expect(failed.results).toEqual([{ testCaseId: 1009, result: "failed", testSetTestCaseId: null, message: "Spira answered 500" }]);
    expect(spira.addToTestSet).toHaveBeenCalledTimes(1);
  });
});
