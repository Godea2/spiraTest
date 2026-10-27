import { describe, expect, it } from "vitest";
import { caseExportRows } from "@/lib/client/case-export";
import type { ReportCatalog, ReportCase, ReportTestSet } from "@/lib/domain/types";

const set = (testSetId: number, name: string, releaseId: number, folderId: number | null = 1): ReportTestSet => ({
  testSetId,
  name,
  folderId,
  releaseId,
  releaseVersion: "1.0",
  status: null,
  owner: null,
  plannedDate: null,
  executionDate: null,
  counts: { passed: 0, failed: 0, caution: 0, blocked: 0, notRun: 0, notApplicable: 0 },
});

const catalog: ReportCatalog = {
  projectId: 24,
  projectName: "Simba",
  releases: [{ releaseId: 1, name: "", versionNumber: "1.0", label: "1.0", depth: 0, active: true, type: null }],
  folders: [{ folderId: 1, parentId: null, name: "SIT Cycle 2" }],
  testSets: [set(10, "Payments - iOS", 1), set(11, "Payments - Android", 1)],
  readAt: "2026-10-12T08:00:00.000Z",
};

const tc = (testCaseId: number, name: string, statusId: number | null = 2): ReportCase => ({
  testSetTestCaseId: testCaseId * 10,
  testCaseId,
  name,
  statusId,
  executionDate: "2026-10-11T10:00:00Z",
  priority: "High",
});

describe("caseExportRows", () => {
  it("builds one Excel row per case in each platform test set", () => {
    const rows = caseExportRows(
      catalog,
      { releaseId: 1, folderId: null },
      [],
      {
        10: [tc(100, "Login")],
        11: [tc(100, "Login"), tc(101, "Balance")],
      },
      "https://example.spiraservice.net",
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.Platform, r["TC ID"], r.Name])).toEqual([
      ["Android", 100, "Login"],
      ["Android", 101, "Balance"],
      ["iOS", 100, "Login"],
    ]);
    expect(rows[0].Link).toContain("/24/TestCase/100.aspx");
    expect(rows[0].Status).toBe("Passed");
  });
});
