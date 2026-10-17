import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Draft } from "@/lib/domain/types";
import type { ProgressTarget } from "@/lib/domain/progress";
import type { MappedImportRow } from "@/lib/client/progress";

const calls = vi.hoisted(() => ({ api: vi.fn(), recordResults: vi.fn() }));

vi.mock("@/lib/client/api", async (importOriginal) => ({ ...(await importOriginal<object>()), api: calls.api }));
vi.mock("@/lib/client/execution", async (importOriginal) => ({ ...(await importOriginal<object>()), recordResults: calls.recordResults }));

const { passProgress, picksFromImport, searchProgress } = await import("@/lib/client/progress");
const { progressTargets } = await import("@/lib/domain/progress");
const { emptyApplyState } = await import("@/lib/domain/draft-ops");
const { getDraft } = await import("@/lib/client/drafts");
const { writeItem } = await import("@/lib/client/storage");

const card = (id: number, over: Partial<Card> = {}): Card => ({
  key: `1:${id}`,
  testSetId: 1,
  testCaseId: id + 1000,
  testSetTestCaseId: id,
  name: id === 1 ? "Verify the customer can recharge a phone line" : id === 2 ? "Verify session timeout after idle" : `Case ${id}`,
  tcId: null,
  executionStatus: "Not Run",
  executed: false,
  suggestion: "inScope",
  reason: "",
  ...over,
});

const draft = {
  id: "payments-ios",
  name: "Payments",
  module: "Payments",
  projectId: 24,
  status: "applied",
  createdAt: "",
  updatedAt: "2026-10-17T08:00:00.000Z",
  testSetIds: [1],
  testSets: [{ testSetId: 1, testSetName: "Payments - iOS", platform: "iOS", comparedAt: "", cards: [1, 2, 3].map((id) => card(id)), missingFromSpira: [], baselineMembership: [1, 2, 3], seal: "" }],
  compareErrors: {},
  decisions: {},
  history: [],
  apply: emptyApplyState(),
  execution: { runs: [], progress: {}, spira: {}, checkedAt: null },
} as unknown as Draft;

const analysis = { feature: "Airtime purchase", related: ["top-up", "recharge"], area: "Payments", summary: "Airtime purchase and top-up on iOS", question: null };

beforeEach(() => {
  calls.api.mockReset();
  calls.recordResults.mockReset();
  writeItem(`draft:${draft.id}`, draft);
  calls.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/understand")) return analysis;
    if (path.endsWith("/search")) return { candidates: [{ key: "1:1", relevance: "high" }, { key: "1:3", relevance: "medium" }] };
    throw new Error(`unexpected ${path}`);
  });
  calls.recordResults.mockImplementation(async (_draftId: string, testSetId: number, cases: Array<{ testCaseId: number; testSetTestCaseId: number }>) => ({
    draft,
    results: cases.map((c) => ({
      testSetId,
      testCaseId: c.testCaseId,
      testSetTestCaseId: c.testSetTestCaseId,
      status: "passed" as const,
      result: "recorded" as const,
      testRunId: 900 + c.testSetTestCaseId,
      message: null,
      spiraStatusId: 2,
    })),
  }));
});

describe("progressTargets", () => {
  it("keeps In Scope and Defects cases, prefers a completed draft, and skips Out of Scope", () => {
    const review = {
      ...draft,
      id: "payments-draft",
      status: "draft",
      updatedAt: "2026-10-18T08:00:00.000Z",
      decisions: { "1:3": "outOfScope" },
      testSets: [{ ...draft.testSets[0], cards: [1, 2, 3].map((id) => card(id)) }],
    } as unknown as Draft;
    const completed = {
      ...draft,
      decisions: { "1:2": "defects", "1:3": "outOfScope" },
    } as unknown as Draft;
    const targets = progressTargets([review, completed]);
    expect(targets.map((t) => t.card.testCaseId)).toEqual([1001, 1002]);
    expect(targets.every((t) => t.draftId === "payments-ios")).toBe(true);
    expect(targets.find((t) => t.card.testCaseId === 1002)?.column).toBe("defects");
  });
});

describe("searchProgress", () => {
  it("understands the work and returns the related cases Gemini picks, without reading steps", async () => {
    const phases: string[] = [];
    const out = await searchProgress([draft], "Tested airtime purchase and top-up on iOS this week", (p) => phases.push(p.stage));
    expect(phases).toEqual(["understanding", "reading"]);
    expect(out.analysis.feature).toBe("Airtime purchase");
    expect(out.cases.map((c) => c.target.card.testCaseId)).toEqual([1001, 1003]);
    expect(out.cases[0].candidate.relevance).toBe("high");
    expect(calls.api.mock.calls.map(([path]) => path)).toEqual(["/api/ai/progress/understand", "/api/ai/progress/search"]);
  });

  it("ends without cases and says why when Gemini cannot work out the feature", async () => {
    const { ApiError } = await import("@/lib/client/api");
    calls.api.mockRejectedValue(new ApiError(502, "No Gemini model answered."));
    const out = await searchProgress([draft], "something vague here");
    expect(out).toMatchObject({ understood: false, complete: false, cases: [], unreadError: expect.stringContaining("Working out the feature") });
  });
});

describe("passProgress", () => {
  it("records Passed runs for the picked cases and skips ones already Passed unless forced", async () => {
    writeItem(`draft:${draft.id}`, {
      ...draft,
      execution: {
        runs: [],
        progress: {},
        spira: { "1:3": { statusId: 2, status: "Passed" } },
        checkedAt: "2026-10-17T09:00:00.000Z",
      },
    });
    const targets = progressTargets([getDraft(draft.id)]);
    const out = await passProgress(targets, "Ada", "Progress: Airtime purchase");
    expect(out.recorded).toBe(2);
    expect(out.failed).toEqual([expect.objectContaining({ message: expect.stringMatching(/Already Passed/) })]);
    expect(calls.recordResults).toHaveBeenCalledWith(
      "payments-ios",
      1,
      expect.arrayContaining([
        expect.objectContaining({ testCaseId: 1001, status: "passed", comment: "Progress: Airtime purchase", steps: [] }),
        expect.objectContaining({ testCaseId: 1002, status: "passed" }),
      ]),
      "Ada",
      expect.any(Object),
    );

    calls.recordResults.mockClear();
    const forced = await passProgress(
      targets.filter((t) => t.card.key === "1:3"),
      "Ada",
      "Progress: retest",
      { force: true },
    );
    expect(forced.recorded).toBe(1);
    expect(forced.failed).toEqual([]);
  });
});

describe("picksFromImport clearSmokeSiblings", () => {
  it("writes Not Run for unticked high/medium smoke matches", () => {
    const target = (key: string, name: string, id: number): ProgressTarget => ({
      draftId: "d1",
      draftName: "Profile",
      module: "Profile",
      completed: true,
      testSetName: "Profile - iOS",
      column: "inScope",
      card: {
        key,
        testSetId: 1,
        testCaseId: id,
        testSetTestCaseId: id,
        name,
        tcId: null,
        executionStatus: "Failed",
        executed: true,
        suggestion: "inScope",
        reason: "",
      },
    });
    const mapped: MappedImportRow[] = [
      {
        key: "1:iOS",
        row: {
          rowNumber: 2,
          sn: "",
          caseId: "SMK-60",
          module: "Profile",
          feature: "Personal data",
          issue: "",
          caseName: "View personal data",
          uatRef: "UAT-PRF-038",
          status: "",
          retest: "",
          iosStatus: "Fail",
          androidStatus: "",
          overallStatus: "Fail",
          platform: "",
          severity: "",
          testerComment: "",
          devComment: "",
          testerName: "",
          expected: "",
          query: "Module: Profile",
        },
        result: "failed",
        reason: "Record as Failed",
        matches: [
          { target: target("1:1", "View personal data", 1), candidate: { key: "1:1", relevance: "high" } },
          { target: target("1:2", "Change email", 2), candidate: { key: "1:2", relevance: "medium" } },
          { target: target("1:3", "Photo", 3), candidate: { key: "1:3", relevance: "low" } },
        ],
        selected: new Set(["d1|1:1"]),
        error: null,
      },
    ];
    const picks = picksFromImport(mapped, { clearSmokeSiblings: true });
    expect(picks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", comment: expect.stringContaining("SMK-60") }),
        expect.objectContaining({ status: "notRun", comment: expect.stringContaining("over-matched") }),
      ]),
    );
    expect(picks.filter((p) => p.status === "notRun")).toHaveLength(1);
    expect(picks.filter((p) => p.status === "failed")).toHaveLength(1);
  });
});
