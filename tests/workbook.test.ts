import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import {
  filterRowsByModule,
  parseWorkbookRows,
  pickDefaultSheet,
  WorkbookError,
} from "@/lib/domain/workbook";

function workbook(sheets: Record<string, unknown[][]>): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return wb;
}

const inScope = [
  ["Release plan"],
  [],
  ["TC ID", "Test Scenario", "Module", "Priority", "Notes"],
  ["ONB-001", "Sign up", "Onboarding", "High", "keep"],
  [null, null, null, null, null],
  ["ACC-001", "View balance", "Accounts", "Low", null],
  ["ONB-002", "Verify email", "  onboarding app ", "Medium", null],
];

describe("workbook parsing", () => {
  it("finds the header row within the first 15 rows and preserves every column", () => {
    const parsed = parseWorkbookRows(workbook({ "Phase 1 In-Scope": inScope }), "Phase 1 In-Scope", null);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toEqual({
      sheet: "Phase 1 In-Scope",
      rowNumber: 4,
      scope: "inScope",
      values: { "TC ID": "ONB-001", "Test Scenario": "Sign up", Module: "Onboarding", Priority: "High", Notes: "keep" },
    });
    expect(parsed.hasModuleColumn).toBe(true);
  });

  it("rejects sheets without TC ID and Test Scenario headers in the first 15 rows", () => {
    const rows = [...Array.from({ length: 15 }, () => ["filler"]), ["TC ID", "Test Scenario"]];
    expect(() => parseWorkbookRows(workbook({ Sheet: rows }), "Sheet", null)).toThrow(WorkbookError);
  });

  it("filters by module name or alias, ignoring case and whitespace", () => {
    const { rows } = parseWorkbookRows(workbook({ S: inScope }), "S", null);
    expect(filterRowsByModule(rows, "Onboarding").map((r) => r.values["TC ID"])).toEqual(["ONB-001"]);
    expect(filterRowsByModule(rows, "Onboarding", "Onboarding App").map((r) => r.values["TC ID"])).toEqual([
      "ONB-001",
      "ONB-002",
    ]);
  });

  it("tags Needs Confirmation rows with their scope", () => {
    const wb = workbook({ "Phase 1 In-Scope": inScope, "Needs Confirmation": inScope.slice(2, 4) });
    const { rows } = parseWorkbookRows(wb, "Phase 1 In-Scope", "Needs Confirmation");
    expect(rows.filter((r) => r.scope === "needsConfirmation")).toHaveLength(1);
  });

  it("picks default sheets case-insensitively", () => {
    expect(pickDefaultSheet(["phase 1 in-scope", "Other"], "Phase 1 In-Scope")).toBe("phase 1 in-scope");
    expect(pickDefaultSheet(["Other"], "Needs Confirmation")).toBeNull();
  });
});
