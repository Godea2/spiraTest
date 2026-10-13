import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, Draft, RunDetail, TestCaseDetail } from "@/lib/domain/types";

const calls = vi.hoisted(() => ({ api: vi.fn(), readTestCase: vi.fn() }));

vi.mock("@/lib/client/api", async (importOriginal) => ({ ...(await importOriginal<object>()), api: calls.api }));
vi.mock("@/lib/client/test-cases", () => ({ readTestCase: calls.readTestCase }));

const { defectForRun, listDefects, prepareRunIncident, raiseRunIncident, undoDefect } = await import("@/lib/client/defects");
const { emptyApplyState } = await import("@/lib/domain/draft-ops");
const { runFailure } = await import("@/lib/domain/defect-report");
const { runnableSteps } = await import("@/lib/domain/execution");
const { writeItem, removeItem } = await import("@/lib/client/storage");

const card: Card = {
  key: "121:75",
  testSetId: 121,
  testCaseId: 3375,
  testSetTestCaseId: 75,
  name: 'Verify a "Balances are now hidden" banner is shown',
  tcId: null,
  executionStatus: "Failed",
  executed: true,
  suggestion: "inScope",
  reason: "",
};

const draft = {
  id: "home-screen-ios",
  name: "Home Screen",
  module: "Home Screen",
  projectId: 24,
  releaseId: 157,
  status: "completed",
  createdAt: "",
  updatedAt: "2026-10-13T08:00:00.000Z",
  testSetIds: [121],
  testSets: [{ testSetId: 121, testSetName: "Home Screen- iOS", platform: "iOS", comparedAt: "", cards: [card], missingFromSpira: [], baselineMembership: [75], seal: "" }],
  compareErrors: {},
  decisions: {},
  history: [],
  apply: emptyApplyState(),
} as unknown as Draft;

const step = (testStepId: number, description: string, expectedResult: string) => ({
  testStepId,
  position: testStepId,
  description,
  expectedResult,
  sampleData: "",
  precondition: "",
  linkedTestCaseId: null,
  linkedName: null,
  linkedSteps: [],
});

const testCase: TestCaseDetail = {
  testCaseId: 3375,
  name: card.name,
  description: "",
  priority: null,
  status: null,
  type: null,
  author: null,
  owner: null,
  customFields: [],
  steps: [step(11, "Open Home", "Balances shown"), step(12, "Tap the eye icon", "Banner 'Balances are now hidden' shows"), step(13, "Tap it again", "Balances shown")],
  truncated: false,
};

const run: RunDetail = {
  testRunId: 8282,
  testCaseId: 3375,
  statusId: 1,
  steps: [
    { testStepId: 11, statusId: 2, actualResult: "" },
    { testStepId: 12, statusId: 1, actualResult: "No banner appears\n\nComment: Seen twice\nExecuted by Daniel Kayode with Spira Test Set Reconciler." },
    { testStepId: 13, statusId: 3, actualResult: "" },
  ],
};

beforeEach(() => {
  calls.api.mockReset();
  calls.readTestCase.mockReset();
  calls.readTestCase.mockResolvedValue(testCase);
  writeItem("defects", []);
  writeItem(`draft:${draft.id}`, draft);
});

describe("runFailure", () => {
  it("finds the failed step, keeps what the tester wrote and their comment, and drops the app's note", () => {
    expect(runFailure(run, runnableSteps(testCase.steps))).toEqual({ stepLabel: "2", actual: "No banner appears\n\nSeen twice", expected: "Banner 'Balances are now hidden' shows" });
  });

  it("matches the step by its id when Spira laid out other steps, and says when none failed", () => {
    const fewer = runnableSteps([testCase.steps[1]]);
    expect(runFailure(run, fewer).stepLabel).toBe("1");
    const none = runFailure({ ...run, steps: [{ testStepId: 11, statusId: 5, actualResult: "Blocked by login\n\nExecuted by Ada with Spira Test Set Reconciler." }] }, runnableSteps(testCase.steps));
    expect(none).toEqual({ stepLabel: null, actual: "Blocked by login", expected: "" });
  });
});

describe("raising a failed run as an incident", () => {
  it("reads the run and its case, then logs one incident linked to that run, kept under Defects", async () => {
    calls.api.mockImplementation(async (path: string) => {
      if (path === "/api/execution/runs") return { runs: [run], errors: [] };
      if (path === "/api/execution/defect") return { incidentId: 301, linked: [{ testRunId: 8282, testRunStepId: 90 }], unlinked: [] };
      throw new Error(`unexpected ${path}`);
    });
    const prepared = await prepareRunIncident(24, card, 8282);
    expect(prepared.failure.stepLabel).toBe("2");
    expect(prepared.reproduce.map((s) => s.label)).toEqual(["1", "2"]);

    const out = await raiseRunIncident(
      {
        draftId: draft.id,
        card,
        testRunId: 8282,
        title: "Home: no banner when balances are hidden",
        description: prepared.failure.actual,
        expected: prepared.failure.expected,
        environment: "iPhone 14, iOS 17.5",
        stepLabel: prepared.failure.stepLabel,
        reproduce: prepared.reproduce,
        fields: { typeId: 1, priorityId: null, severityId: 3 },
        files: [],
      },
      "Daniel Kayode",
    );
    expect(out.incident?.incidentId).toBe(301);
    const body = calls.api.mock.calls.find(([path]) => path === "/api/execution/defect")![1].body;
    expect(body.runs).toEqual([{ board: 0, testRunId: 8282, testCaseId: 3375, testSetId: 121, testSetTestCaseId: 75 }]);
    expect(body.defect).toMatchObject({ name: "Home: no banner when balances are hidden", typeId: 1, severityId: 3 });
    expect(body.defect.description).toContain("## What happened\nNo banner appears\n\nSeen twice");
    expect(body.defect.description).toContain("## Steps to reproduce\n1. Open Home\n2. Tap the eye icon\n   Expected: Banner 'Balances are now hidden' shows");
    expect(body.defect.description).toContain("## Environment\niPhone 14, iOS 17.5");

    const record = defectForRun(8282)!;
    expect(record).toMatchObject({ origin: "execution", incidentId: 301, cases: [{ testRunId: 8282, stepLabel: "2", from: "inScope" }] });
    await expect(raiseRunIncident({ draftId: draft.id, card, testRunId: 8282, title: "Again", description: "No banner again", expected: "", environment: "", stepLabel: "2", reproduce: [], fields: { typeId: null, priorityId: null, severityId: null }, files: [] }, "Ada")).rejects.toThrow(/already logged as incident 301/);
  });

  it("keeps the defect to log again when the incident could not be created", async () => {
    calls.api.mockRejectedValue(new Error("Spira did not answer."));
    const out = await raiseRunIncident({ draftId: draft.id, card, testRunId: 8282, title: "Home: no banner", description: "No banner appears", expected: "", environment: "", stepLabel: "2", reproduce: [], fields: { typeId: null, priorityId: null, severityId: null }, files: [] }, "Ada");
    expect(out.incidentError).toBe("Spira did not answer.");
    expect(defectForRun(8282)).toMatchObject({ incidentId: null, origin: "execution" });
  });

  it("undo deletes only the incident and keeps the failed run", async () => {
    writeItem("defects", [
      {
        id: "from-run",
        projectId: 24,
        at: "2026-10-13T09:49:00.000Z",
        title: "Home: no banner",
        description: "No banner appears",
        tester: "Ada",
        report: "",
        incidentId: 301,
        linkedSteps: 1,
        cases: [{ draftId: draft.id, module: "Home Screen", testSetId: 121, testCaseId: 3375, testSetTestCaseId: 75, name: card.name, testRunId: 8282, stepLabel: "2", from: "inScope" }],
        origin: "execution",
      },
    ]);
    calls.api.mockResolvedValue({ ok: true, message: null });
    const out = await undoDefect("from-run", []);
    expect(out.errors).toEqual([]);
    expect(calls.api.mock.calls.map(([path]) => path)).toEqual(["/api/execution/defect/undo"]);
    expect(listDefects(24)).toEqual([]);
    removeItem("defects");
  });
});
