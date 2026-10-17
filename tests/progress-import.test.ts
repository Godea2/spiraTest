import { describe, expect, it } from "vitest";
import {
  fieldForHeader,
  findImportHeader,
  fitsPlatform,
  matchImportModules,
  parseImportRows,
  parseOutcomeStatus,
  rowOutcomes,
  sheetPlatform,
  suggestSheetResult,
} from "@/lib/domain/progress-import";

describe("fieldForHeader", () => {
  it("recognises issue-log and smoke-pack headers", () => {
    expect(fieldForHeader("Module")).toBe("module");
    expect(fieldForHeader("Feature / Area")).toBe("feature");
    expect(fieldForHeader("Feature / Journey")).toBe("feature");
    expect(fieldForHeader("Issue Observed")).toBe("issue");
    expect(fieldForHeader("Retest Result")).toBe("retest");
    expect(fieldForHeader("Platform / Device")).toBe("platform");
    expect(fieldForHeader("Status")).toBe("status");
    expect(fieldForHeader("Tester's Comment")).toBe("testerComment");
    expect(fieldForHeader("Tester")).toBe("testerName");
    expect(fieldForHeader("S/N")).toBe("sn");
    expect(fieldForHeader("ST ID")).toBe("caseId");
    expect(fieldForHeader("Smoke Test Case")).toBe("caseName");
    expect(fieldForHeader("UAT TC Ref")).toBe("uatRef");
    expect(fieldForHeader("iOS – Status")).toBe("iosStatus");
    expect(fieldForHeader("Android – Status")).toBe("androidStatus");
    expect(fieldForHeader("Overall Status")).toBe("overallStatus");
    expect(fieldForHeader("Screenshot")).toBeNull();
  });
});

describe("findImportHeader + parseImportRows (issue log)", () => {
  it("finds the header under a title row and parses actionable rows", () => {
    const matrix = [
      ["Project Simba", null, null],
      ["Date:", "10-Oct-2026", null],
      ["S/N", "Module", "Feature / Area", "Issue Observed", "Status", "Platform / Device", "Retest Result", "Tester's Comment"],
      [1, "Onboarding & identity", "Biometrics", "Ooops error on Continue", "Closed", "", "Pass", "16-Oct-2026 Retest message now reads…"],
      [2, "Transfers", "Balance Update", "Balance not updating", "Open", "Android", "Fail", "14/15-Oct Retest Still FAILING"],
      [3, "Payments", "Utilities", "Bill payment not submitting", "Closed", "", "Pass", ""],
      [4, "Onboarding", "BVN", "Accepts any number", "Open", "", "", "Ready for retest"],
      [5, "Onboarding", "Card option", "Random card numbers", "Deferred", "", "", ""],
    ];
    const map = findImportHeader(matrix);
    expect(map?.headerRow).toBe(2);
    expect(map?.kind).toBe("issues");
    expect(map?.fields.module).toBe("Module");
    expect(map?.fields.retest).toBe("Retest Result");
    const sheet = parseImportRows(matrix, map!, "Sheet1");
    expect(sheet.rows).toHaveLength(5);
    expect(sheet.actionable).toBe(4);
    expect(sheet.skipped).toBe(1);
    expect(suggestSheetResult(sheet.rows[0].status, sheet.rows[0].retest, sheet.rows[0].testerComment)).toBe("passed");
    expect(suggestSheetResult(sheet.rows[1].status, sheet.rows[1].retest, sheet.rows[1].testerComment)).toBe("failed");
    expect(suggestSheetResult(sheet.rows[3].status, sheet.rows[3].retest, sheet.rows[3].testerComment)).toBeNull();
    expect(suggestSheetResult(sheet.rows[4].status, sheet.rows[4].retest, sheet.rows[4].testerComment)).toBe("blocked");
  });
});

describe("smoke pack headers and outcomes", () => {
  it("detects a UAT smoke pack and splits iOS / Android results", () => {
    const matrix = [
      ["Smoke Test Pack"],
      [
        "ST ID",
        "Module",
        "Feature / Journey",
        "UAT TC Ref",
        "Smoke Test Case",
        "iOS – Status",
        "Android – Status",
        "Overall Status",
        "Tester",
        "Comments",
      ],
      [
        "SMK-01",
        "Customer Onboarding & Home Screen",
        "Existing Customers Onboarding",
        "UAT-ONB-001",
        "Successful onboarding of existing UBA customer (happy path)",
        "Pass",
        "Pass",
        "Pass",
        "Adejumoke Ariyibi",
        "",
      ],
      [
        "SMK-02",
        "Customer Onboarding & Home Screen",
        "Your data review",
        "UAT-ONB-012",
        "Your data review",
        "Fail",
        "Fail",
        "Fail",
        "Adejumoke Ariyibi",
        "Name Not",
      ],
      [
        "SMK-17",
        "Accounts & Transactions",
        "Account Details",
        "UAT-ACC-001",
        "View account details",
        "Not Run",
        "Not Run",
        "Not Run",
        "Adejumoke Ariyibi",
        "",
      ],
      [
        "SMK-31",
        "Transfers",
        "UBA to Other Banks",
        "UAT-TRF-044",
        "UBA to other bank transfer – happy path",
        "Fail",
        "Fail",
        "Fail",
        "Adejumoke Ariyibi",
        "Balance not updated",
      ],
    ];
    const map = findImportHeader(matrix);
    expect(map?.kind).toBe("smoke");
    expect(map?.fields.caseId).toBe("ST ID");
    expect(map?.fields.iosStatus).toBe("iOS – Status");
    const sheet = parseImportRows(matrix, map!, "Smoke");
    expect(sheet.testerName).toBe("Adejumoke Ariyibi");
    expect(sheet.actionable).toBe(3);
    expect(sheet.skipped).toBe(1);
    expect(rowOutcomes(sheet.rows[0], "smoke")).toEqual([
      { platform: "iOS", result: "passed", label: "iOS" },
      { platform: "Android", result: "passed", label: "Android" },
    ]);
    expect(rowOutcomes(sheet.rows[1], "smoke").map((o) => o.result)).toEqual(["failed", "failed"]);
    expect(rowOutcomes(sheet.rows[2], "smoke")).toEqual([]);
  });

  it("skips a Summary-only matrix", () => {
    const matrix = [
      ["Smoke Test Pack – Summary"],
      ["Module", "Test Cases", "Pass", "Fail", "Blocked", "Not Run", "Pass Rate (of executed)"],
      ["Customer Onboarding & Home Screen", 16, 9, 4, 0, 3, "69%"],
    ];
    expect(findImportHeader(matrix)).toBeNull();
  });
});

describe("suggestSheetResult / parseOutcomeStatus", () => {
  it("lets Retest Result win, and parses smoke Pass/Fail/Blocked/Not Run", () => {
    expect(suggestSheetResult("Open", "Pass (Data)", "")).toBe("passed");
    expect(suggestSheetResult("Closed", "Fail", "")).toBe("failed");
    expect(suggestSheetResult("Closed", "", "10-Oct-2026 Retest Total Balance Now populated")).toBe("passed");
    expect(suggestSheetResult("Closed", "", "To Close")).toBeNull();
    expect(suggestSheetResult("Open", "", "Ready for retest")).toBeNull();
    expect(suggestSheetResult("Deferred", "", "For subsequent Sprint")).toBe("blocked");
    expect(parseOutcomeStatus("Pass")).toBe("passed");
    expect(parseOutcomeStatus("fail")).toBe("failed");
    expect(parseOutcomeStatus("Blocked")).toBe("blocked");
    expect(parseOutcomeStatus("Not Run")).toBeNull();
    expect(parseOutcomeStatus("N/A")).toBeNull();
  });
});

describe("module and platform helpers", () => {
  it("matches Onboarding & identity to Onboarding, and filters platforms", () => {
    expect(matchImportModules("Onboarding & identity", ["Onboarding", "Payments", "Home Screen"])).toEqual(["Onboarding"]);
    expect(matchImportModules("Customer Onboarding & Home Screen", ["Customer Onboarding & Home Screen", "Transfers"])).toEqual([
      "Customer Onboarding & Home Screen",
    ]);
    expect(matchImportModules("", ["Onboarding", "Payments"])).toEqual(["Onboarding", "Payments"]);
    expect(sheetPlatform("Android")).toBe("Android");
    expect(sheetPlatform("Both")).toBe("both");
    expect(fitsPlatform("Payments- Android", "Android")).toBe(true);
    expect(fitsPlatform("Payments - iOS", "Android")).toBe(false);
    expect(fitsPlatform("Payments - iOS", "both")).toBe(true);
  });
});
