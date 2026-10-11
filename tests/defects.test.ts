import { describe, expect, it } from "vitest";
import {
  compareMatches,
  defectProgress,
  incidentDescription,
  incidentSignature,
  isGrounded,
  pickBySeverity,
  rankByWording,
  settleDefectVerdicts,
  stepsToReproduce,
  type RawDefectVerdict,
  type VerifiedCase,
} from "@/lib/domain/defects";
import { executedSteps, fillRunSteps, invalidResult, runnableSteps, RUNNER_NAME } from "@/lib/domain/execution";
import type { TestCaseStep } from "@/lib/domain/types";

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
      reproduce: stepsToReproduce(steps, "2"),
      failAt: "2",
      cases: [{ testCaseId: 3519, name: "Cannot proceed without phone", stepLabel: "2", stepText: "Tap Continue", testRunId: 901 }],
    });
    expect(text).toContain("Continue is enabled with an empty phone number.");
    expect(text).toContain("Expected: Continue stays disabled.");
    expect(text).toContain("1. Launch app (data: Phone: (empty))");
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
});
