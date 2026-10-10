import { describe, expect, it } from "vitest";
import { reconcileTestSet, type SetCase } from "@/lib/domain/matching";
import type { WorkbookRow } from "@/lib/domain/types";

const row = (tcId: string, scenario: string, scope: WorkbookRow["scope"] = "inScope", rowNumber = 2): WorkbookRow => ({
  sheet: scope === "inScope" ? "In-Scope" : "Needs Confirmation",
  rowNumber,
  scope,
  values: { "TC ID": tcId, "Test Scenario": scenario, Module: "Onboarding" },
});

let nextId = 1;
const spiraCase = (name: string, extra: Partial<SetCase> = {}): SetCase => {
  const id = nextId++;
  return { testSetTestCaseId: 1000 + id, testCaseId: id, name, executionStatus: "Not Run", executed: false, customText: [], ...extra };
};

const only = (rows: WorkbookRow[], c: SetCase) => reconcileTestSet(125, rows, [c]).cards[0];

describe("matching workbook rows to Spira test cases", () => {
  it("matches a TC ID in the test case name", () => {
    const card = only([row("TC-ONB-001", "Verify sign up")], spiraCase("TC-ONB-001: Sign up with phone"));
    expect(card).toMatchObject({ suggestion: "inScope", tcId: "TC-ONB-001" });
    expect(card.reason).toMatch(/TC ID/);
  });

  it("tolerates different separators and case in the TC ID", () => {
    expect(only([row("TC-ONB-001", "x")], spiraCase("tc onb 001 sign up")).suggestion).toBe("inScope");
    expect(only([row("TC-ONB-001", "x")], spiraCase("[TC_ONB_001] sign up")).suggestion).toBe("inScope");
  });

  it("does not treat a longer ID as a match", () => {
    const card = only([row("TC-ONB-001", "Verify sign up")], spiraCase("TC-ONB-0010 Something else"));
    expect(card.suggestion).toBe("outOfScope");
  });

  it("matches a TC ID stored in a custom property", () => {
    const card = only([row("TC-ONB-007", "Verify login")], spiraCase("Login works", { customText: ["TC-ONB-007"] }));
    expect(card).toMatchObject({ suggestion: "inScope", tcId: "TC-ONB-007" });
  });

  it("falls back to the test scenario, ignoring case and punctuation", () => {
    const card = only([row("TC-ONB-002", "Verify alphabetic characters are rejected")], spiraCase("verify alphabetic characters are rejected."));
    expect(card).toMatchObject({ suggestion: "inScope", tcId: "TC-ONB-002" });
    expect(card.reason).toMatch(/test scenario/);
  });

  it("sends Needs Confirmation rows to Needs Review", () => {
    const card = only([row("TC-ONB-003", "Verify search", "needsConfirmation")], spiraCase("TC-ONB-003 search"));
    expect(card.suggestion).toBe("needsReview");
    expect(card.reason).toMatch(/Needs Confirmation/);
  });

  it("sends a case listed on both sheets to Needs Review", () => {
    const rows = [row("TC-ONB-003", "Verify search"), row("TC-ONB-003", "Verify search", "needsConfirmation", 9)];
    expect(only(rows, spiraCase("TC-ONB-003 search")).suggestion).toBe("needsReview");
  });

  it("sends a case that matches several different rows to Needs Review", () => {
    const rows = [row("TC-ONB-004", "a"), row("TC-ONB-005", "b", "inScope", 3)];
    const card = only(rows, spiraCase("TC-ONB-004 and TC-ONB-005 combined"));
    expect(card.suggestion).toBe("needsReview");
    expect(card.reason).toMatch(/more than one/);
  });

  it("flags a close but inexact scenario for review instead of removal", () => {
    const rows = [row("TC-ONB-006", "Verify existing customer cannot proceed without entering a phone number")];
    const card = only(rows, spiraCase("Verify an existing customer cannot proceed without entering phone number"));
    expect(card.suggestion).toBe("needsReview");
    expect(card.reason).toMatch(/close to TC-ONB-006/);
  });

  it("suggests Out of Scope for cases not in the workbook", () => {
    const card = only([row("TC-ONB-001", "Verify sign up")], spiraCase("Legacy statement export"));
    expect(card).toMatchObject({ suggestion: "outOfScope", tcId: null });
  });

  it("keeps execution details and lists rows with no test case as missing", () => {
    const rows = [row("TC-ONB-001", "Verify sign up"), row("TC-ONB-009", "Verify logout", "inScope", 5)];
    const out = reconcileTestSet(125, rows, [spiraCase("TC-ONB-001 sign up", { executed: true, executionStatus: "Passed" })]);
    expect(out.cards[0]).toMatchObject({ executed: true, executionStatus: "Passed", key: `125:${out.cards[0].testSetTestCaseId}` });
    expect(out.missingFromSpira).toEqual([
      { tcId: "TC-ONB-009", testScenario: "Verify logout", reason: "No test case in this test set has this TC ID or test scenario." },
    ]);
  });

  it("reports sorted membership for every case, including duplicates of the same test case", () => {
    const a = spiraCase("TC-ONB-001 sign up", { testSetTestCaseId: 9002, testCaseId: 77 });
    const b = spiraCase("TC-ONB-001 sign up", { testSetTestCaseId: 9001, testCaseId: 77 });
    const out = reconcileTestSet(125, [row("TC-ONB-001", "x")], [a, b]);
    expect(out.membership).toEqual([9001, 9002]);
    expect(out.cards.map((c) => c.suggestion)).toEqual(["inScope", "inScope"]);
  });
});
