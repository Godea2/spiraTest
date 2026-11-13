import { describe, expect, it } from "vitest";
import {
  groupRowsByModule,
  groupRowsByStatus,
  normalizeCaseStatus,
  overallCounts,
  safeSheetName,
  summarizeByModulePlatform,
  toCaseRows,
  type CaseRow,
} from "@/lib/domain/testcase-workbook";

const row = (partial: Partial<CaseRow> & Pick<CaseRow, "TC ID" | "Module" | "Status">): CaseRow => ({
  Name: partial.Name ?? `Case ${partial["TC ID"]}`,
  Platform: partial.Platform ?? "Android",
  "Test set": partial["Test set"] ?? "Set",
  Priority: partial.Priority ?? "High",
  "Last run": partial["Last run"] ?? "",
  Link: partial.Link ?? "",
  ...partial,
});

describe("testcase workbook helpers", () => {
  it("normalizes Spira status labels", () => {
    expect(normalizeCaseStatus("Passed")).toBe("Passed");
    expect(normalizeCaseStatus("not run")).toBe("Not Run");
    expect(normalizeCaseStatus("")).toBe("Not Run");
    expect(normalizeCaseStatus("Weird")).toBe("Other");
  });

  it("keeps sheet names unique within 31 chars", () => {
    const used = new Set<string>();
    expect(safeSheetName("Customer Onboarding & Home Screen", used)).toBe("Customer Onboarding & Home Scre");
    expect(safeSheetName("Customer Onboarding & Home Screen", used)).toMatch(/\(2\)/);
  });

  it("maps export rows and summarizes by module × platform", () => {
    const rows = toCaseRows([
      { "TC ID": 1, Name: "A", Module: "Transfers", Platform: "Android", "Test set": "T-A", Priority: "", Status: "Passed", "Last run": "", Link: "" },
      { "TC ID": 2, Name: "B", Module: "Transfers", Platform: "Android", "Test set": "T-A", Priority: "", Status: "Failed", "Last run": "", Link: "" },
      { "TC ID": 1, Name: "A", Module: "Transfers", Platform: "iOS", "Test set": "T-I", Priority: "", Status: "Passed", "Last run": "", Link: "" },
    ]);
    const summary = summarizeByModulePlatform(rows);
    expect(summary).toHaveLength(2);
    const android = summary.find((s) => s.Platform === "Android")!;
    expect(android.Passed).toBe(1);
    expect(android.Failed).toBe(1);
    expect(android.Total).toBe(2);
    expect(android["Pass rate"]).toBe("50%");
  });

  it("groups Master into module sheets and status buckets", () => {
    const rows = [
      row({ "TC ID": 1, Module: "Payments", Status: "Passed", Platform: "iOS" }),
      row({ "TC ID": 2, Module: "Transfers", Status: "Failed", Platform: "Android" }),
      row({ "TC ID": 3, Module: "Transfers", Status: "Not Run", Platform: "Android" }),
    ];
    const byModule = groupRowsByModule(rows);
    expect([...byModule.keys()]).toEqual(["Payments", "Transfers"]);
    expect(byModule.get("Transfers")).toHaveLength(2);

    const byStatus = groupRowsByStatus(rows);
    expect(byStatus.get("Passed")).toHaveLength(1);
    expect(byStatus.get("Failed")).toHaveLength(1);
    expect(byStatus.get("Not Run")).toHaveLength(1);

    expect(overallCounts(rows)).toMatchObject({ Passed: 1, Failed: 1, "Not Run": 1, Total: 3 });
  });
});
