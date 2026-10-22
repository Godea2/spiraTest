import { describe, expect, it } from "vitest";
import { countColumns } from "@/lib/domain/board";
import {
  compareMatches,
  defectProgress,
  defectTargets,
  failedForDefect,
  heldByOtherDefect,
  incidentDescription,
  incidentSignature,
  isGrounded,
  mergeCandidates,
  pickBySeverity,
  rankByWording,
  rankExistingDefectPool,
  sameNameCases,
  settleDefectVerdicts,
  similarDefects,
  sortExistingDefectHits,
  stepsToReproduce,
  strongExistingDefect,
  wordingSimilarity,
  type ExistingDefectHit,
  type RawDefectVerdict,
  type VerifiedCase,
} from "@/lib/domain/defects";
import { emptyApplyState, recordMoves } from "@/lib/domain/draft-ops";
import { executedSteps, executionCards, fillRunSteps, invalidResult, runnableSteps, RUNNER_NAME } from "@/lib/domain/execution";
import type { Card, DefectRecord, Draft, TestCaseStep } from "@/lib/domain/types";

const step = (description: string, expectedResult = "", sampleData = "", testStepId: number | null = null): TestCaseStep => ({
  testStepId,
  position: 1,
  description,
  expectedResult,
  sampleData,
  precondition: "",
  linkedTestCaseId: null,
  linkedName: null,
  linkedSteps: [],
});

const loginCase: VerifiedCase = {
  key: "1:1",
  name: "Verify existing customer cannot proceed without entering a phone number",
  steps: [
    { label: "1", description: "Launch app", expectedResult: "", sampleData: "Phone number: (empty)" },
    { label: "2", description: "Leave the phone number field empty", expectedResult: "", sampleData: "" },
    { label: "3", description: 'Tap "Continue with phone number"', expectedResult: "Continue button remains disabled", sampleData: "" },
  ],
};

const verdict = (over: Partial<RawDefectVerdict> = {}): RawDefectVerdict => ({
  key: "1:1",
  verdict: "fails",
  confidence: "high",
  stepLabel: "3",
  evidence: "Tap \u201cContinue with phone number\u201d",
  reason: "Step 3 expects the button to stay disabled.",
  ...over,
});

describe("grounding", () => {
  it("finds a quote word for word, ignoring case, quotes and punctuation", () => {
    expect(isGrounded('tap "continue with phone number"', ['Tap "Continue with phone number"'])).toBe(true);
    expect(isGrounded("Continue button remains disabled.", ["Continue button remains disabled / user cannot proceed"])).toBe(true);
  });

  it("rejects paraphrases, partial words and empty quotes", () => {
    expect(isGrounded("Tap the continue button", ['Tap "Continue with phone number"'])).toBe(false);
    expect(isGrounded("ontinue", ["Continue"])).toBe(false);
    expect(isGrounded("", ["anything"])).toBe(false);
  });
});

describe("settleDefectVerdicts", () => {
  it("keeps a failing verdict whose step exists and whose evidence is in the case", () => {
    const [m] = settleDefectVerdicts([verdict()], [loginCase]);
    expect(m).toMatchObject({ verdict: "fails", stepLabel: "3", grounded: true });
  });

  it("offers a failing verdict as possible when the evidence is not in the case", () => {
    const [m] = settleDefectVerdicts([verdict({ evidence: "Tap the green button" })], [loginCase]);
    expect(m).toMatchObject({ verdict: "possible", grounded: false, stepLabel: "3" });
  });

  it("offers a failing verdict as possible when the step does not exist, or confidence is low", () => {
    expect(settleDefectVerdicts([verdict({ stepLabel: "9" })], [loginCase])[0]).toMatchObject({ verdict: "possible", stepLabel: null });
    expect(settleDefectVerdicts([verdict({ confidence: "low" })], [loginCase])[0].verdict).toBe("possible");
  });

  it("accepts a failing case without steps when its name holds the evidence", () => {
    const noSteps: VerifiedCase = { key: "1:2", name: "Verify OTP screen opens after Continue", steps: [] };
    const [m] = settleDefectVerdicts([verdict({ key: "1:2", stepLabel: null, evidence: "OTP screen opens" })], [noSteps]);
    expect(m).toMatchObject({ verdict: "fails", stepLabel: null, grounded: true });
  });

  it("drops unknown keys and duplicates, and reports a skipped case as possible", () => {
    const other: VerifiedCase = { ...loginCase, key: "1:3" };
    const out = settleDefectVerdicts([verdict(), verdict({ verdict: "unaffected" }), verdict({ key: "9:9" })], [loginCase, other]);
    expect(out.map((m) => [m.key, m.verdict])).toEqual([
      ["1:1", "fails"],
      ["1:3", "possible"],
    ]);
  });

  it("clears the step and evidence of an unaffected case", () => {
    const [m] = settleDefectVerdicts([verdict({ verdict: "unaffected" })], [loginCase]);
    expect(m).toMatchObject({ verdict: "unaffected", stepLabel: null, evidence: "", grounded: false });
  });

  it("sorts failing cases first, surer ones first", () => {
    const base = settleDefectVerdicts([verdict()], [loginCase])[0];
    const sorted = [
      { ...base, verdict: "possible" as const },
      { ...base, confidence: "medium" as const },
      { ...base, verdict: "unaffected" as const },
      base,
    ].sort(compareMatches);
    expect(sorted.map((m) => `${m.verdict}/${m.confidence}`)).toEqual(["fails/high", "fails/medium", "possible/high", "unaffected/high"]);
  });
});

describe("failing a case for a defect", () => {
  const steps = runnableSteps([step("Launch app", "", "", 11), step("Leave the field empty", "", "", 12), step("Tap Continue", "Button disabled", "", 13), step("Check OTP", "", "", 14)]);

  it("passes the steps before the failure, fails the step with the description and leaves the rest Not Run", () => {
    const progress = defectProgress(steps, "3", "Continue is enabled and opens the OTP screen.", true);
    expect(progress.steps).toEqual({
      "1": { status: "passed", actualResult: "" },
      "2": { status: "passed", actualResult: "" },
      "3": { status: "failed", actualResult: "Continue is enabled and opens the OTP screen." },
    });
  });

  it("can leave the earlier steps unmarked", () => {
    expect(Object.keys(defectProgress(steps, "3", "x happened here", false).steps)).toEqual(["3"]);
  });

  it("rejects a step the case does not have", () => {
    expect(() => defectProgress(steps, "9", "x", true)).toThrow();
  });

  it("produces a result the server accepts and Spira's run can carry", () => {
    const sent = executedSteps(defectProgress(steps, "3", "Continue is enabled.", true), steps);
    expect(invalidResult("failed", "Defect: Login: Continue enabled", sent)).toBeNull();
    const filled = fillRunSteps(
      [11, 12, 13, 14].map((testStepId) => ({ testStepId, testCaseId: 5 })),
      "failed",
      sent,
      "Comment: Defect: Login",
    );
    expect(filled?.map((f) => f.status)).toEqual(["passed", "passed", "failed", null]);
    expect(filled?.[2].actualResult).toBe("Continue is enabled.\n\nComment: Defect: Login");
  });
});

describe("incident description", () => {
  const steps = runnableSteps([step("Launch app", "", "Phone: (empty)"), step("Tap Continue", "Button disabled"), step("Check OTP")]);

  it("has the description, steps to reproduce up to the failure, the failed cases and the app's signature", () => {
    const text = incidentDescription({
      runner: RUNNER_NAME,
      tester: "Ada",
      description: "Continue is enabled with an empty phone number.",
      expected: "Continue stays disabled.",
      environment: "iPhone 14, iOS 17.5",
      reproduce: stepsToReproduce(steps, "2"),
      failAt: "2",
      cases: [{ testCaseId: 3519, name: "Cannot proceed without phone", stepLabel: "2", stepText: "Tap Continue", testRunId: 901 }],
    });
    expect(text).toContain("## What happened\nContinue is enabled with an empty phone number.");
    expect(text).toContain("## Expected result\nContinue stays disabled.");
    expect(text).toContain("## Steps to reproduce\n1. Launch app (data: Phone: (empty))");
    expect(text).toContain("## Environment\niPhone 14, iOS 17.5");
    expect(text.indexOf("## Environment")).toBeLessThan(text.indexOf("## Failed test cases"));
    expect(text).toContain("2. Tap Continue\n   Expected: Button disabled");
    expect(text).not.toContain("Check OTP");
    expect(text).toContain("- TC3519 Cannot proceed without phone, step 2: Tap Continue (test run 901)");
    expect(text).toContain(`Found by Ada. ${incidentSignature(RUNNER_NAME)}`);
  });
});

describe("helpers", () => {
  it("narrows a long list to the cases sharing the most words, in their original order", () => {
    const items = ["Profile photo upload", "Phone number Continue disabled", "Card freeze", "Continue with phone number"].map((text, i) => ({ key: String(i), text }));
    expect(rankByWording("Continue enabled with empty phone number", items, 2).map((i) => i.key)).toEqual(["1", "3"]);
    expect(rankByWording("anything", items, 10)).toHaveLength(4);
  });

  it("picks Spira's severity by name, else by rank", () => {
    const named = [{ id: 1, name: "1 - Critical" }, { id: 2, name: "2 - High" }, { id: 3, name: "3 - Medium" }];
    expect(pickBySeverity(named, "high")?.id).toBe(2);
    const unnamed = [{ id: 7, name: "P1" }, { id: 8, name: "P2" }];
    expect(pickBySeverity(unnamed, "medium")?.id).toBe(8);
    expect(pickBySeverity([], "low")).toBeNull();
  });

  it("merges shortlists by relevance, taking each part in turn, without repeats", () => {
    const c = (key: string, relevance: "high" | "medium" | "low") => ({ key, relevance });
    const merged = mergeCandidates(
      [
        [c("a1", "high"), c("a2", "high"), c("a3", "medium")],
        [c("b1", "high"), c("a1", "high"), c("b2", "low")],
      ],
      4,
    );
    expect(merged.map((x) => x.key)).toEqual(["a1", "b1", "a2", "a3"]);
  });
});

describe("searching across modules", () => {
  const card = (testSetId: number, id: number, suggestion: Card["suggestion"]): Card => ({
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
  const draft = (id: string, module: string, status: Draft["status"], cards: Card[], updatedAt = "2026-10-01", removed: number[] = []): Draft =>
    ({
      id,
      name: module,
      module,
      projectId: 24,
      status,
      updatedAt,
      testSets: [{ testSetId: cards[0].testSetId, testSetName: `TX${cards[0].testSetId}`, platform: "iOS", comparedAt: "", cards, missingFromSpira: [], baselineMembership: [], seal: "" }],
      decisions: {},
      history: [],
      apply: { ...emptyApplyState(), removed: removed.length ? { [String(cards[0].testSetId)]: removed } : {} },
    }) as unknown as Draft;

  it("covers every case of a draft, but only what is still in Spira for a completed module", () => {
    const onboarding = draft("d1", "Onboarding", "draft", [card(1, 1, "inScope"), card(1, 2, "outOfScope"), card(1, 3, "needsReview")]);
    const home = draft("d2", "Home Screen", "applied", [card(2, 4, "inScope"), card(2, 5, "outOfScope"), card(2, 6, "blocked")], "2026-10-02", [5]);
    const targets = defectTargets([onboarding, home]);
    expect(targets.map((t) => `${t.module}:${t.card.testSetTestCaseId}:${t.column}`)).toEqual([
      "Home Screen:4:inScope",
      "Home Screen:6:blocked",
      "Onboarding:1:inScope",
      "Onboarding:2:outOfScope",
      "Onboarding:3:needsReview",
    ]);
  });

  it("leaves out cards a live apply removed, and searches a case on two drafts once, from the completed one", () => {
    const applied = draft("d1", "Onboarding", "applied", [card(1, 1, "inScope"), card(1, 2, "inScope")], "2026-09-01", [2]);
    const copy = draft("d2", "Onboarding", "draft", [card(1, 1, "inScope"), card(1, 2, "inScope")], "2026-10-05");
    const targets = defectTargets([copy, applied]);
    expect(targets.map((t) => `${t.draftId}:${t.card.testSetTestCaseId}`)).toEqual(["d1:1"]);
  });

  it("moves cards to Defects and back as one board step that asks for a new membership check", () => {
    const d = draft("d1", "Onboarding", "draft", [card(1, 1, "inScope"), card(1, 2, "outOfScope")]);
    d.apply.preflight = { ok: true } as Draft["apply"]["preflight"];
    const changes = recordMoves(d, [{ key: "1:1", to: "defects" }, { key: "1:2", to: "defects" }], "Defect", "2026-10-11T09:00:00Z");
    expect(changes).toHaveLength(2);
    expect(d.decisions).toEqual({ "1:1": "defects", "1:2": "defects" });
    expect(d.apply.preflight).toBeNull();
    expect(d.history).toEqual([{ at: "2026-10-11T09:00:00Z", label: "Defect", changes }]);
    const cards = d.testSets[0].cards;
    expect(executionCards(d).map((c) => c.key)).toEqual(["1:1", "1:2"]);
    expect(countColumns(cards, d.decisions)).toMatchObject({ inScope: 0, defects: 2, outOfScope: 0 });

    recordMoves(d, [{ key: "1:1", to: "inScope" }, { key: "1:2", to: "outOfScope" }], "Undo", "2026-10-11T10:00:00Z");
    expect(d.decisions).toEqual({});
    expect(recordMoves(d, [{ key: "1:1", to: "inScope" }], "Nothing", "x")).toEqual([]);
    expect(d.history).toHaveLength(2);
  });

  it("keeps a case in Defects while another defect holds it", () => {
    const record = (id: string, draftId: string, key: [number, number]) =>
      ({ id, cases: [{ draftId, testSetId: key[0], testSetTestCaseId: key[1] }] }) as unknown as DefectRecord;
    const records = [record("a", "d1", [1, 1]), record("b", "d1", [1, 1]), record("c", "d2", [1, 2])];
    expect(heldByOtherDefect(records, "a", "d1", "1:1")).toBe(true);
    expect(heldByOtherDefect(records, "c", "d2", "1:2")).toBe(false);
    expect(heldByOtherDefect(records, "a", "d2", "1:1")).toBe(false);
  });

  it("finds a defect raised before from a reworded description, but not a different one", () => {
    const raised = (id: string, description: string) => ({ id, description, cases: [] }) as unknown as DefectRecord;
    const records = [
      raised("mtn", 'MTN missing from the Data network provider list. An MTN number defaults to "Common".'),
      raised("otp", "Unable to login, the OTP never arrives by SMS."),
    ];
    expect(similarDefects(records, "MTN is missing from the data network provider list; an MTN number defaults to Common").map((m) => m.record.id)).toEqual(["mtn"]);
    expect(similarDefects(records, "Airtime purchase fails with a timeout for Glo numbers")).toEqual([]);
    expect(similarDefects(records, "MTN")).toEqual([]);
    expect(wordingSimilarity("same words here", "Same words, here!")).toBe(1);
  });

  it("knows which defect already failed a membership, in any draft", () => {
    const records = [{ id: "a", cases: [{ draftId: "d1", testSetId: 1, testSetTestCaseId: 7 }] }] as unknown as DefectRecord[];
    expect(failedForDefect(records, 1, 7)?.id).toBe("a");
    expect(failedForDefect(records, 1, 8)).toBeNull();
    expect(failedForDefect(records, 2, 7)).toBeNull();
  });

  it("flags a new test case named like an existing one, but not one that differs in its key word", () => {
    const cases = [{ name: "Verify MTN appears in the Data network provider list" }, { name: "Verify a transaction receipt downloads" }];
    expect(sameNameCases("Verify that MTN appears in the data network provider list", cases)).toEqual([cases[0]]);
    expect(sameNameCases("Verify Glo appears in the Data network provider list", cases)).toEqual([]);
  });

  it("groups the failed cases by module in the incident when they span modules", () => {
    const text = incidentDescription({
      runner: RUNNER_NAME,
      tester: "Ada",
      description: "Balance shows 0.00 after login.",
      expected: "",
      reproduce: [],
      failAt: null,
      cases: [
        { testCaseId: 1, name: "Login", module: "Onboarding", stepLabel: null, stepText: "", testRunId: 901 },
        { testCaseId: 2, name: "Balance card", module: "Home Screen", stepLabel: "3", stepText: "View balance", testRunId: 902 },
      ],
    });
    expect(text).not.toContain("## Expected result");
    expect(text).not.toContain("## Environment");
    expect(text).toContain("## Failed test cases (2 in 2 modules)\nOnboarding:\n- TC1 Login (test run 901)\nHome Screen:\n- TC2 Balance card, step 3: View balance (test run 902)");
  });

  it("ranks Spira and app defects by wording for the find-existing pool", () => {
    const app = [
      { id: "a1", title: "OTP never arrives", description: "Unable to login, the OTP never arrives by SMS." },
      { id: "a2", title: "Balance is blank", description: "Home balance card shows a blank amount." },
    ] as unknown as DefectRecord[];
    const pool = rankExistingDefectPool(
      "Login fails because the OTP SMS never arrives",
      { feature: "Login OTP", related: ["SMS"], symptom: "OTP never arrives", title: "OTP SMS missing" },
      [
        { incidentId: 10, name: "OTP SMS not delivered on login", status: "Open", open: true },
        { incidentId: 11, name: "Airtime purchase timeout", status: "Closed", open: false },
      ],
      app,
      3,
    );
    expect(pool[0]).toMatchObject({ key: "spira:10", source: "spira", incidentId: 10, open: true });
    expect(pool.map((p) => p.key)).toContain("app:a1");
    expect(pool.map((p) => p.key)).not.toContain("app:a2");
  });

  it("sorts existing hits Spira-first then by relevance, and gates strong matches", () => {
    const hit = (over: Partial<ExistingDefectHit>): ExistingDefectHit => ({
      key: "x",
      source: "app",
      incidentId: null,
      recordId: "r",
      title: "t",
      text: "t",
      status: null,
      open: true,
      relevance: "low",
      reason: "",
      ...over,
    });
    const sorted = sortExistingDefectHits([
      hit({ key: "app:1", source: "app", relevance: "high" }),
      hit({ key: "spira:2", source: "spira", incidentId: 2, relevance: "low" }),
      hit({ key: "spira:9", source: "spira", incidentId: 9, relevance: "medium" }),
    ]);
    expect(sorted.map((h) => h.key)).toEqual(["spira:9", "spira:2", "app:1"]);
    expect(strongExistingDefect(sorted)).toBe(true);
    expect(strongExistingDefect([hit({ relevance: "low" })])).toBe(false);
    expect(strongExistingDefect([])).toBe(false);
  });
});
