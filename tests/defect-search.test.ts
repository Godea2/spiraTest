import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, DefectMatch, Draft, TestCaseDetail } from "@/lib/domain/types";

const calls = vi.hoisted(() => ({ api: vi.fn(), readTestCase: vi.fn() }));

vi.mock("@/lib/client/api", async (importOriginal) => ({ ...(await importOriginal<object>()), api: calls.api }));
vi.mock("@/lib/client/test-cases", () => ({ readTestCase: calls.readTestCase }));

const { newCaseDuplicates, raiseDefect, searchDefect } = await import("@/lib/client/defects");
const { emptyApplyState } = await import("@/lib/domain/draft-ops");
const { defectTargets } = await import("@/lib/domain/defects");
const { writeItem } = await import("@/lib/client/storage");

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
    if (path.endsWith("/incidents")) return { incidents: [], complete: true };
    if (path.endsWith("/find-existing")) return { hits: [] };
    if (path.endsWith("/search")) return { candidates: ["1:1", "1:2", "1:3", "1:4", "1:5"].map((key) => ({ key, relevance: "high" })) };
    return { matches: init.body.cases.map((c) => verdict(c.key, c.key !== "1:2")) };
  });
});

describe("searchDefect", () => {
  it("checks Spira and app defects with no modules chosen, without looking for cases", async () => {
    calls.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/understand")) return analysis;
      if (path.endsWith("/incidents")) {
        return {
          incidents: [{ incidentId: 99, name: "OTP never arrives on login", status: "Open", open: true }],
          complete: true,
        };
      }
      if (path.endsWith("/find-existing")) {
        return {
          hits: [
            {
              key: "spira:99",
              source: "spira",
              incidentId: 99,
              recordId: null,
              title: "OTP never arrives on login",
              text: "OTP never arrives on login Open",
              status: "Open",
              open: true,
              relevance: "high",
              reason: "Same OTP login failure",
            },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const out = await searchDefect(24, [], "unable to login, not getting otp", () => {});
    expect(out).toMatchObject({
      modules: 0,
      total: 0,
      cases: [],
      complete: true,
      existing: [{ key: "spira:99", relevance: "high" }],
    });
    expect(calls.api.mock.calls.some(([path]) => String(path).endsWith("/search"))).toBe(false);
  });

  it("checks steps batch by batch as they are read, showing verdicts as they come", async () => {
    const partials: number[] = [];
    const out = await searchDefect(24, [draft], "unable to login, not getting otp", () => {}, (s) => partials.push(s.cases.length));

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

  it("offers a case whose steps could not be read or checked as possibly affected", async () => {
    calls.readTestCase.mockImplementation(async (_p: number, testCaseId: number) => {
      if (testCaseId === 1003) throw new Error("Spira did not answer.");
      return detail(testCaseId);
    });
    const out = await searchDefect(24, [draft], "unable to login, not getting otp", () => {});
    expect(out.cases.find((c) => c.target.card.key === "1:3")?.match).toMatchObject({ verdict: "possible", reason: expect.stringContaining("Spira did not answer") });

    calls.api.mockImplementation(async (path: string, init: { body: { cases: Array<{ key: string }> } }) => {
      if (path.endsWith("/understand")) return analysis;
      if (path.endsWith("/incidents")) return { incidents: [], complete: true };
      if (path.endsWith("/find-existing")) return { hits: [] };
      if (path.endsWith("/search")) return { candidates: [{ key: "1:1", relevance: "high" }] };
      throw new Error("Gemini is answering slowly right now.");
    });
    const unchecked = await searchDefect(24, [draft], "unable to login again, not getting otp", () => {});
    expect(unchecked).toMatchObject({ complete: false, cases: [{ match: { verdict: "possible", reason: expect.stringContaining("answering slowly") } }] });
  });

  it("ends without cases, saying why, when Gemini cannot work out the feature or match the cases", async () => {
    calls.api.mockImplementation(async () => {
      throw new Error("No Gemini model answered.");
    });
    const unread = await searchDefect(24, [draft], "MTN missing from the Data network provider list", () => {});
    expect(unread).toMatchObject({ understood: false, complete: false, searched: 0, total: 6, cases: [], unreadError: "Working out the feature: No Gemini model answered." });
    expect(unread.analysis.title).toBe("MTN missing from the Data network provider list");

    calls.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/understand")) return analysis;
      if (path.endsWith("/incidents")) return { incidents: [], complete: true };
      if (path.endsWith("/find-existing")) return { hits: [] };
      throw new Error("No Gemini model answered.");
    });
    const unmatched = await searchDefect(24, [draft], "MTN missing from the Data network provider list again", () => {});
    expect(unmatched).toMatchObject({ understood: true, complete: false, searched: 0, cases: [], unreadError: 'Matching cases to "Sign-in": No Gemini model answered.' });
  });

  it("never fails a case again that a defect already failed, and never repeats a test case created for one", async () => {
    const earlier = {
      id: "old",
      projectId: 24,
      at: "2026-10-11T20:00:00.000Z",
      title: "Sign-in: OTP never arrives",
      description: "Unable to login, not getting otp",
      tester: "Ada",
      report: "",
      incidentId: 259,
      linkedSteps: 1,
      cases: [{ draftId: "d1", module: "Onboarding", testSetId: 1, testCaseId: 1001, testSetTestCaseId: 1, name: "Case 1", testRunId: 9, stepLabel: "1", from: "inScope" }],
      created: { testCaseId: 6579, name: "Verify downloading a transaction receipt downloads the receipt file", memberships: [] },
    };
    writeItem("defects", [earlier]);

    const target = defectTargets([draft]).find((t) => t.card.key === "1:1")!;
    const out = await raiseDefect(
      {
        picks: [{ target, steps: [], stepLabel: null }],
        description: "Unable to login again, OTP not received",
        title: "OTP not received",
        expected: "",
        passBefore: true,
        logIncident: true,
        fields: { typeId: null, priorityId: null, severityId: null },
      },
      "Ada",
    );
    expect(out.record).toBeNull();
    expect(out.failed.map((f) => f.message)).toEqual([expect.stringMatching(/^Already failed for "Sign-in: OTP never arrives" \(.*incident 259\)\. Undo that defect/)]);
    expect(calls.api).not.toHaveBeenCalled();

    expect(newCaseDuplicates(24, [], "Verify that downloading a transaction receipt downloads the receipt file").map((d) => d.testCaseId)).toEqual([6579]);
    expect(newCaseDuplicates(24, [], "Verify sharing a transaction receipt by email")).toEqual([]);
  });

  it("asks once more after a short wait when every Gemini model was busy, but not twice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { ApiError } = await import("@/lib/client/api");
      let busyMatches = 1;
      calls.api.mockImplementation(async (path: string, init: { body: { cases: Array<{ key: string }> } }) => {
        if (path.endsWith("/understand")) return analysis;
        if (path.endsWith("/incidents")) return { incidents: [], complete: true };
        if (path.endsWith("/find-existing")) return { hits: [] };
        if (path.endsWith("/search")) {
          if (busyMatches-- > 0) throw new ApiError(503, "Gemini is overloaded right now.");
          return { candidates: [{ key: "1:1", relevance: "high" }] };
        }
        return { matches: init.body.cases.map((c) => verdict(c.key, true)) };
      });
      const pending = searchDefect(24, [draft], "airtime purchase fails for MTN", () => {});
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toMatchObject({ cases: [{ match: { verdict: "fails" } }] });
      expect(calls.api.mock.calls.filter(([path]) => String(path).endsWith("/search"))).toHaveLength(2);

      busyMatches = 2;
      const failing = searchDefect(24, [draft], "airtime purchase fails for Glo", () => {});
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(failing).resolves.toMatchObject({ searched: 0, cases: [], unreadError: expect.stringContaining("overloaded") });
    } finally {
      vi.useRealTimers();
    }
  });
});
