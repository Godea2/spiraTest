import { describe, expect, it } from "vitest";
import { SIGN_OFF_COLUMN, validateApplyBatch, type ApplyBoard } from "@/lib/domain/apply-rules";
import { emptyApplyState, recordBlockedReview, recordSignOffResults, recordSignOffUndo } from "@/lib/domain/draft-ops";
import {
  applyProposals,
  blockedCandidates,
  blockedProposals,
  defaultSelection,
  hasCurrentAiVerdict,
  keywordAssessment,
  keywordHits,
  keywordReport,
  matchKeywords,
  parseKeywords,
} from "@/lib/domain/keywords";
import { reconcileTestSet } from "@/lib/domain/matching";
import type { BlockedAssessment, Card, Draft, SignOffResult, TestSetComparison } from "@/lib/domain/types";

function card(id: number, suggestion: Card["suggestion"], name = `Case ${id}`, workbookScenario?: string): Card {
  return {
    key: `1:${id}`,
    testSetId: 1,
    testCaseId: id + 1000,
    testSetTestCaseId: id,
    name,
    tcId: null,
    executionStatus: "Not Run",
    executed: false,
    suggestion,
    reason: "",
    ...(workbookScenario ? { workbookScenario } : {}),
  };
}

const AT = "2026-01-01T00:00:00.000Z";
const ai = (keywords: string[], blocked: boolean, confidence: BlockedAssessment["confidence"] = "high"): BlockedAssessment => ({
  keywords,
  blocked,
  confidence,
  reason: blocked ? "Depends on the feature." : "Only mentions it in passing.",
  source: "ai",
  at: AT,
});

describe("keyword matching", () => {
  it("matches whole words regardless of case", () => {
    expect(matchKeywords("Verify NIN on signup", ["nin"])).toEqual(["nin"]);
    expect(matchKeywords("nin-based lookup", ["nin"])).toEqual(["nin"]);
    expect(matchKeywords("BVN/NIN toggle", ["nin", "bvn"])).toEqual(["nin", "bvn"]);
    expect(matchKeywords("User is running the app", ["nin"])).toEqual([]);
    expect(matchKeywords("Beginning of flow", ["nin"])).toEqual([]);
  });

  it("matches plurals and possessives of a keyword", () => {
    expect(matchKeywords("Guests cannot pay", ["guest"])).toEqual(["guest"]);
    expect(matchKeywords("The guest's profile", ["guest"])).toEqual(["guest"]);
    expect(matchKeywords("Guestbook", ["guest"])).toEqual([]);
  });

  it("matches multi-word keywords across spaces, hyphens and underscores", () => {
    expect(matchKeywords("Tap Google sign-in", ["google sign in"])).toEqual(["google sign in"]);
    expect(matchKeywords("google_sign_in button", ["google sign in"])).toEqual(["google sign in"]);
  });

  it("treats regex characters in keywords literally", () => {
    expect(matchKeywords("Pay with c++ sdk", ["c++"])).toEqual(["c++"]);
    expect(matchKeywords("Pay with c sdk", ["c++"])).toEqual([]);
  });

  it("parses typed keyword lists", () => {
    expect(parseKeywords("nin, bvn;google\n NIN ,")).toEqual(["nin", "bvn", "google"]);
  });

  it("searches only the test scenario: the Spira name and the workbook Test Scenario", () => {
    const cards = [card(1, "inScope", "Login with BVN"), card(2, "inScope", "TC-ONB-002", "Pay as guest"), card(3, "inScope", "Happy path")];
    const hits = keywordHits(cards, { "1": ["bvn", "guest", "nin"] });
    expect(Object.fromEntries(hits)).toEqual({ "1:1": ["bvn"], "1:2": ["guest"] });
  });

  it("applies a test set's keywords only to that test set", () => {
    const android = card(1, "inScope", "Google sign in with BVN");
    const ios = { ...card(2, "inScope", "Google sign in with BVN"), key: "2:2", testSetId: 2 };
    const hits = keywordHits([android, ios], { "2": ["google"] });
    expect(Object.fromEntries(hits)).toEqual({ "2:2": ["google"] });
  });

  it("reports where each keyword was found, by current column", () => {
    const cards = [card(1, "inScope", "BVN check"), card(2, "outOfScope", "BVN legacy"), card(3, "needsReview", "BVN maybe"), card(4, "inScope", "Other")];
    const report = keywordReport(cards, { "1:1": "blocked" }, { "1": ["bvn", "google"] });
    const keys = (cs: Card[]) => cs.map((c) => c.key);
    expect(report.map((r) => [r.keyword, keys(r.byColumn.inScope), keys(r.byColumn.blocked), keys(r.byColumn.outOfScope), keys(r.byColumn.needsReview)])).toEqual([
      ["bvn", [], ["1:1"], ["1:2"], ["1:3"]],
      ["google", [], [], [], []],
    ]);
  });
});

describe("blocked review", () => {
  const byTestSet = { "1": ["bvn"] };

  it("reviews only In Scope and Blocked cards whose scenario mentions a keyword", () => {
    const cards = [card(1, "inScope", "BVN check"), card(2, "outOfScope", "BVN legacy"), card(3, "needsReview", "BVN maybe"), card(4, "inScope", "Other")];
    expect(blockedCandidates(cards, { "1:3": "blocked" }, byTestSet).map((c) => [c.card.key, c.keywords])).toEqual([
      ["1:1", ["bvn"]],
      ["1:3", ["bvn"]],
    ]);
  });

  it("proposes Blocked for keyword verdicts and follows AI verdicts both ways", () => {
    const cards = [card(1, "inScope", "Link BVN"), card(2, "inScope", "Choose BVN or NIN"), card(3, "inScope", "Pay with BVN")];
    const review = { "1:1": keywordAssessment(["bvn"], AT), "1:2": ai(["bvn"], false), "1:3": ai(["bvn"], true) };
    const proposals = blockedProposals(cards, {}, byTestSet, review);
    expect(proposals.map((p) => [p.card.key, p.proposed, p.assessment?.source])).toEqual([
      ["1:1", "blocked", "keyword"],
      ["1:2", "inScope", "ai"],
      ["1:3", "blocked", "ai"],
    ]);
  });

  it("offers Blocked cards whose scenario no longer mentions a keyword back to In Scope", () => {
    const cards = [card(1, "inScope", "Existing customer completes onboarding via the happy path")];
    const [proposal] = blockedProposals(cards, { "1:1": "blocked" }, byTestSet, {});
    expect(proposal).toMatchObject({ proposed: "inScope", kind: "noKeyword", keywords: [] });
    expect(defaultSelection([proposal]).size).toBe(0);
  });

  it("ignores saved verdicts made for a different set of keywords", () => {
    const cards = [card(1, "inScope", "Link BVN")];
    const [proposal] = blockedProposals(cards, {}, byTestSet, { "1:1": ai(["nin"], false) });
    expect(proposal.assessment).toBeNull();
    expect(proposal.proposed).toBe("blocked");
    expect(hasCurrentAiVerdict(ai(["bvn"], false), ["bvn"])).toBe(true);
    expect(hasCurrentAiVerdict(keywordAssessment(["bvn"], AT), ["bvn"])).toBe(false);
  });

  it("pre-selects confident changes only and applies the chosen ones", () => {
    const cards = [card(1, "inScope", "Link BVN"), card(2, "blocked", "BVN or NIN"), card(3, "inScope", "Maybe BVN"), card(4, "inScope", "BVN again")];
    const review = { "1:1": ai(["bvn"], true), "1:2": ai(["bvn"], false), "1:3": ai(["bvn"], true, "low"), "1:4": ai(["bvn"], false) };
    const proposals = blockedProposals(cards, {}, byTestSet, review);
    const selected = defaultSelection(proposals);
    expect([...selected]).toEqual(["1:1", "1:2"]);

    const { decisions, changes } = applyProposals(cards, {}, proposals, selected);
    expect(changes).toEqual([
      { key: "1:1", from: "inScope", to: "blocked" },
      { key: "1:2", from: "blocked", to: "inScope" },
    ]);
    expect(decisions).toEqual({ "1:1": "blocked", "1:2": "inScope" });
  });

  it("stores verdicts on the draft and records when the filter ran", () => {
    const d = { blockedReview: { "1:9": ai(["bvn"], true) } } as unknown as Draft;
    recordBlockedReview(d, { "1:1": ai(["bvn"], false) }, AT);
    expect(Object.keys(d.blockedReview ?? {})).toEqual(["1:9", "1:1"]);
    expect(d.keywordsFilteredAt).toBe(AT);
  });
});

describe("workbook scenario on cards", () => {
  it("copies only the matched row's Test Scenario, not steps or data", () => {
    const rows = [
      {
        sheet: "In-Scope",
        rowNumber: 2,
        scope: "inScope" as const,
        values: { "TC ID": "TC-ONB-001", "Test Scenario": "Sign up", "Test Steps": "Enter NIN", "Test Data": "NIN 123" },
      },
    ];
    const cases = [
      { testSetTestCaseId: 1, testCaseId: 11, name: "TC-ONB-001 Sign up", executionStatus: "Not Run", executed: false, customText: [] },
      { testSetTestCaseId: 2, testCaseId: 12, name: "Unrelated", executionStatus: "Not Run", executed: false, customText: [] },
    ];
    const { cards } = reconcileTestSet(1, rows, cases);
    expect(cards[0].workbookScenario).toBe("Sign up");
    expect(cards[1].workbookScenario).toBeUndefined();
    expect(Object.fromEntries(keywordHits(cards, { "1": ["nin"] }))).toEqual({});
  });
});

describe("recording results is limited to the right column", () => {
  const cards = [card(1, "inScope"), card(2, "inScope"), card(3, "outOfScope")];
  const set: TestSetComparison = {
    testSetId: 1,
    testSetName: "Set",
    platform: "iOS",
    comparedAt: "",
    cards,
    missingFromSpira: [],
    baselineMembership: [1, 2, 3],
    seal: "",
  };
  const now = Date.parse("2026-01-01T00:10:00Z");
  const board: ApplyBoard = {
    module: "Onboarding",
    testSets: [set],
    decisions: { "1:2": "blocked" },
    preflight: { at: "2026-01-01T00:00:00Z", ok: true, sets: [], seal: "x" },
  };
  const action = (id: number) => ({ testCaseId: id + 1000, testSetTestCaseId: id });

  it("accepts Blocked cards for Blocked results and In Scope cards for Passed results", () => {
    const live = { testSetId: 1, dryRun: false, confirmModule: "ONBOARDING" };
    expect(() => validateApplyBatch(board, { ...live, actions: [action(2)] }, now, SIGN_OFF_COLUMN.blocked)).not.toThrow();
    expect(() => validateApplyBatch(board, { ...live, actions: [action(1)] }, now, SIGN_OFF_COLUMN.passed)).not.toThrow();
  });

  it("rejects cards from any other column", () => {
    const dry = { testSetId: 1, dryRun: true };
    expect(() => validateApplyBatch(board, { ...dry, actions: [action(1)] }, now, "blocked")).toThrow(/not a Blocked card/);
    expect(() => validateApplyBatch(board, { ...dry, actions: [action(3)] }, now, "inScope")).toThrow(/not a In Scope card/);
  });

  it("still requires the typed module and a fresh membership check for live runs", () => {
    expect(() => validateApplyBatch(board, { testSetId: 1, dryRun: false, actions: [action(2)] }, now, "blocked")).toThrow(/Type ONBOARDING/);
    const stale = { ...board, preflight: { ...board.preflight!, at: "2025-12-31T00:00:00Z" } };
    expect(() =>
      validateApplyBatch(stale, { testSetId: 1, dryRun: false, confirmModule: "ONBOARDING", actions: [action(2)] }, now, "blocked"),
    ).toThrow(/more than 15 minutes/);
  });
});

describe("recorded test runs on the draft", () => {
  const draft = () => ({ apply: emptyApplyState() }) as Draft;
  const result = (id: number, outcome: SignOffResult["result"], testRunId: number | null = null): SignOffResult => ({
    testSetId: 1,
    testCaseId: id + 1000,
    testSetTestCaseId: id,
    status: "blocked",
    result: outcome,
    testRunId,
    message: null,
  });

  it("keeps run IDs for undo and failures for retry", () => {
    const d = draft();
    recordSignOffResults(d, false, [result(1, "recorded", 501), result(2, "failed"), result(3, "skipped")], new Date("2026-01-01T00:00:00Z"));
    expect(d.apply.signOffRuns).toEqual([{ testSetId: 1, testCaseId: 1001, testSetTestCaseId: 1, status: "blocked", testRunId: 501, at: "2026-01-01T00:00:00.000Z" }]);
    expect(d.apply.signOffFailed).toEqual([{ testSetId: 1, testCaseId: 1002, testSetTestCaseId: 2, status: "blocked" }]);

    recordSignOffResults(d, false, [result(2, "recorded", 502)]);
    expect(d.apply.signOffFailed).toEqual([]);
    expect(d.apply.signOffRuns?.map((r) => r.testRunId)).toEqual([501, 502]);

    recordSignOffUndo(d, [501]);
    expect(d.apply.signOffRuns?.map((r) => r.testRunId)).toEqual([502]);
  });

  it("dry runs change nothing", () => {
    const d = draft();
    recordSignOffResults(d, true, [result(1, "wouldRecord"), result(2, "failed")]);
    expect(d.apply.signOffRuns).toEqual([]);
    expect(d.apply.signOffFailed).toEqual([]);
  });
});
