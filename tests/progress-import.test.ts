import { describe, expect, it } from "vitest";
import {
  fieldForHeader,
  findImportHeader,
  fitsPlatform,
  matchImportModules,
  parseImportRows,
  sheetPlatform,
  suggestSheetResult,
} from "@/lib/domain/progress-import";

describe("fieldForHeader", () => {
  it("recognises the Project Simba progress sheet headers without hard-coding that file", () => {
    expect(fieldForHeader("Module")).toBe("module");
    expect(fieldForHeader("Feature / Area")).toBe("feature");
    expect(fieldForHeader("Issue Observed")).toBe("issue");
    expect(fieldForHeader("Retest Result")).toBe("retest");
    expect(fieldForHeader("Platform / Device")).toBe("platform");
    expect(fieldForHeader("Status")).toBe("status");
    expect(fieldForHeader("Tester's Comment")).toBe("testerComment");
    expect(fieldForHeader("S/N")).toBe("sn");
    expect(fieldForHeader("Screenshot")).toBeNull();
  });
});

describe("findImportHeader + parseImportRows", () => {
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

describe("suggestSheetResult", () => {
  it("lets Retest Result win, and treats Closed-with-retest-pass as Passed", () => {
    expect(suggestSheetResult("Open", "Pass (Data)", "")).toBe("passed");
    expect(suggestSheetResult("Closed", "Fail", "")).toBe("failed");
    expect(suggestSheetResult("Closed", "", "10-Oct-2026 Retest Total Balance Now populated")).toBe("passed");
    expect(suggestSheetResult("Closed", "", "To Close")).toBeNull();
    expect(suggestSheetResult("Open", "", "Ready for retest")).toBeNull();
    expect(suggestSheetResult("Deferred", "", "For subsequent Sprint")).toBe("blocked");
  });
});

describe("module and platform helpers", () => {
  it("matches Onboarding & identity to Onboarding, and filters platforms", () => {
    expect(matchImportModules("Onboarding & identity", ["Onboarding", "Payments", "Home Screen"])).toEqual(["Onboarding"]);
    expect(matchImportModules("", ["Onboarding", "Payments"])).toEqual(["Onboarding", "Payments"]);
    expect(sheetPlatform("Android")).toBe("Android");
    expect(sheetPlatform("Both")).toBe("both");
    expect(fitsPlatform("Payments- Android", "Android")).toBe(true);
    expect(fitsPlatform("Payments - iOS", "Android")).toBe(false);
    expect(fitsPlatform("Payments - iOS", "both")).toBe(true);
  });
});
