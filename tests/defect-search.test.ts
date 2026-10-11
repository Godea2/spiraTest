import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, DefectMatch, Draft, TestCaseDetail } from "@/lib/domain/types";

const calls = vi.hoisted(() => ({ api: vi.fn(), readTestCase: vi.fn() }));

vi.mock("@/lib/client/api", async (importOriginal) => ({ ...(await importOriginal<object>()), api: calls.api }));
vi.mock("@/lib/client/test-cases", () => ({ readTestCase: calls.readTestCase }));

const { searchDefect } = await import("@/lib/client/defects");
const { emptyApplyState } = await import("@/lib/domain/draft-ops");

const card = (id: number): Card => ({
  key: `1:${id}`,
  testSetId: 1,
  testCaseId: id + 1000,
  testSetTestCaseId: id,
  name: `Case ${id}`,
  tcId: null,
  executionStatus: "Passed",
  executed: true,
  suggestion: "inScope",
  reason: "",
});

const draft = {
  id: "d1",
  name: "Onboarding",
  module: "Onboarding",
  projectId: 24,
  status: "draft",
  createdAt: "",
  updatedAt: "",
  testSetIds: [1],
  testSets: [{ testSetId: 1, testSetName: "Onboarding iOS", platform: "iOS", comparedAt: "", cards: [1, 2, 3, 4, 5, 6].map(card), missingFromSpira: [], baselineMembership: [], seal: "" }],
  compareErrors: {},
  decisions: {},
  history: [],
  apply: emptyApplyState(),
} as unknown as Draft;

const analysis = { title: "Sign-in: OTP not received", feature: "Sign-in", related: ["OTP"], area: "Sign-in", symptom: "No OTP", expected: "", severity: "critical", question: null };

const detail = (testCaseId: number): TestCaseDetail => ({
  testCaseId,
  name: `Case ${testCaseId - 1000}`,
  description: "",
  priority: null,
  status: null,
  type: null,
  author: null,
  owner: null,
  customFields: [],
  steps: [{ testStepId: 1, position: 1, description: "Enter the OTP", expectedResult: "Signed in", sampleData: "", precondition: "", linkedTestCaseId: null, linkedName: null, linkedSteps: [] }],
  truncated: false,
});

const verdict = (key: string, fails: boolean): DefectMatch => ({
  key,
  verdict: fails ? "fails" : "unaffected",
  confidence: "high",
  stepLabel: fails ? "1" : null,
  evidence: fails ? "Enter the OTP" : "",
  grounded: fails,
  reason: "",
});

beforeEach(() => {
  calls.api.mockReset();
  calls.readTestCase.mockReset();
  calls.readTestCase.mockImplementation(async (_p: number, testCaseId: number) => detail(testCaseId));
  calls.api.mockImplementation(async (path: string, init: { body: { cases: Array<{ key: string }> } }) => {
    if (path.endsWith("/understand")) return analysis;
    if (path.endsWith("/search")) return { candidates: ["1:1", "1:2", "1:3", "1:4", "1:5"].map((key) => ({ key, relevance: "high" })) };
    return { matches: init.body.cases.map((c) => verdict(c.key, c.key !== "1:2")) };
  });
});

describe("searchDefect", () => {
  it("checks steps batch by batch as they are read, showing verdicts as they come", async () => {
    const partials: number[] = [];
    const out = await searchDefect([draft], "unable to login, not getting otp", () => {}, (s) => partials.push(s.cases.length));

    expect(out.cases.map((c) => [c.target.card.key, c.match.verdict])).toEqual([
      ["1:1", "fails"],
      ["1:3", "fails"],
      ["1:4", "fails"],
      ["1:5", "fails"],
      ["1:2", "unaffected"],
    ]);
    const verifyCalls = calls.api.mock.calls.filter(([path]) => String(path).endsWith("/verify"));
    expect(verifyCalls.map(([, init]) => (init as { body: { cases: unknown[] } }).body.cases.length)).toEqual([4, 1]);
    expect(verifyCalls[0][1]).toMatchObject({ body: { analysis: { feature: "Sign-in", related: ["OTP"] } } });
    expect(partials).toEqual([4, 5]);
  });

  it("offers a case whose steps could not be read as possibly affected, and fails only when every check fails", async () => {
    calls.readTestCase.mockImplementation(async (_p: number, testCaseId: number) => {
      if (testCaseId === 1003) throw new Error("Spira did not answer.");
      return detail(testCaseId);
    });
    const out = await searchDefect([draft], "unable to login, not getting otp", () => {});
    expect(out.cases.find((c) => c.target.card.key === "1:3")?.match).toMatchObject({ verdict: "possible", reason: expect.stringContaining("Spira did not answer") });

    calls.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/understand")) return analysis;
      if (path.endsWith("/search")) return { candidates: [{ key: "1:1", relevance: "high" }] };
      throw new Error("Gemini is answering slowly right now.");
    });
    await expect(searchDefect([draft], "unable to login again, not getting otp", () => {})).rejects.toThrow(/answering slowly/);
  });
});
