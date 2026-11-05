import { describe, expect, it } from "vitest";
import { emptyMatrixStore, resultId, type MatrixCase, type MatrixResult } from "@/lib/domain/matrix";
import { buildMatrixReport, matrixReportStatus } from "@/lib/domain/matrix-report";

const caseOf = (partial: Partial<MatrixCase> & Pick<MatrixCase, "key" | "testCaseId" | "name" | "module" | "platform">): MatrixCase => ({
  testSetId: 1,
  testSetTestCaseId: partial.testCaseId,
  testSetName: `${partial.module} - ${partial.platform}`,
  ...partial,
});

describe("matrix report", () => {
  it("is amber when nothing has run", () => {
    expect(matrixReportStatus({ releaseId: 1, releaseLabel: "x", cells: [], executedCells: 0, coveredCells: 0, failedCells: 0, totalCells: 12 }, 0)).toMatchObject({
      status: "amber",
    });
  });

  it("is green when every cell is covered with no failures", () => {
    expect(
      matrixReportStatus({ releaseId: 1, releaseLabel: "x", cells: [], executedCells: 12, coveredCells: 12, failedCells: 0, totalCells: 12 }, 0),
    ).toMatchObject({ status: "green" });
  });

  it("is red when any cell failed", () => {
    expect(
      matrixReportStatus({ releaseId: 1, releaseLabel: "x", cells: [], executedCells: 3, coveredCells: 2, failedCells: 1, totalCells: 12 }, 2),
    ).toMatchObject({ status: "red" });
  });

  it("builds an executive report from the matrix store", () => {
    const store = emptyMatrixStore(24);
    store.releaseId = 170;
    store.releaseLabel = "1.0.0.0.0006";
    store.catalogLoadedAt = "2026-11-05T10:00:00.000Z";
    store.cases = [
      caseOf({ key: "1:1", testCaseId: 1, name: "Login with OTP", module: "Onboarding", platform: "Android" }),
      caseOf({ key: "1:2", testCaseId: 2, name: "Transfer money", module: "Transactions", platform: "Android" }),
    ];
    const result: MatrixResult = {
      id: resultId("Samsung", "MTN", "1:1"),
      caseKey: "1:1",
      testCaseId: 1,
      module: "Onboarding",
      device: "Samsung",
      network: "MTN",
      status: "passed",
      comment: "",
      tester: "Ada",
      at: "2026-11-05T11:00:00.000Z",
      sessionId: "mx-1",
      releaseId: 170,
    };
    store.results = [result];

    const report = buildMatrixReport(store, {
      projectId: 24,
      projectName: "Project-Simba",
      preparedBy: "QA",
      releaseId: 170,
    });

    expect(report.title).toContain("matrix");
    expect(report.releaseLabel).toBe("1.0.0.0.0006");
    expect(report.kpis.cells).toBe(12);
    expect(report.kpis.started).toBe(1);
    expect(report.kpis.passed).toBe(1);
    expect(report.status).toBe("amber");
    expect(report.cells).toHaveLength(12);
  });
});
