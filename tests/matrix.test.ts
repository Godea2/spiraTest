import { describe, expect, it } from "vitest";
import {
  buildCoverage,
  catalogLooksComplete,
  emptyMatrixStore,
  isProdMatrixModule,
  matrixBucketKey,
  modulesInSession,
  normalizeMatrixPlatform,
  platformForDevice,
  prodModuleLabel,
  repairMatrixCases,
  resultId,
  selectSessionCases,
  sessionCounts,
  upsertResult,
  type MatrixCase,
  type MatrixResult,
  type MatrixSession,
} from "@/lib/domain/matrix";

const caseOf = (partial: Partial<MatrixCase> & Pick<MatrixCase, "key" | "testCaseId" | "name" | "module" | "platform">): MatrixCase => ({
  testSetId: 1,
  testSetTestCaseId: partial.testCaseId,
  testSetName: `${partial.module} - ${partial.platform}`,
  ...partial,
});

describe("matrix domain", () => {
  it("maps devices to Spira platforms", () => {
    expect(platformForDevice("iOS")).toBe("iOS");
    expect(platformForDevice("Samsung")).toBe("Android");
    expect(platformForDevice("itel")).toBe("Android");
    expect(platformForDevice("Infinix")).toBe("Android");
    expect(platformForDevice("tecno")).toBe("Android");
  });

  it("recovers Android/iOS from Spira test-set names when tags are wrong", () => {
    expect(normalizeMatrixPlatform("Cards - iOS", "Other")).toBe("iOS");
    expect(normalizeMatrixPlatform("Accounts & Transactions- Android", "Web")).toBe("Android");
    expect(normalizeMatrixPlatform("Cards - iOS", "iOS")).toBe("iOS");
    const repaired = repairMatrixCases([
      caseOf({
        key: "1:1",
        testCaseId: 1,
        name: "Freeze",
        module: "Cards",
        platform: "Other",
        testSetName: "Cards - iOS",
      }),
    ]);
    expect(repaired[0].platform).toBe("iOS");
    expect(catalogLooksComplete([])).toBe(false);
  });

  it("selects every Spira case on the device platform", () => {
    const catalog = [
      caseOf({ key: "1:1", testCaseId: 1, name: "Login with OTP", module: "Accounts & Transactions", platform: "Android" }),
      caseOf({ key: "2:2", testCaseId: 2, name: "Login with OTP", module: "Accounts & Transactions", platform: "iOS" }),
      caseOf({ key: "1:3", testCaseId: 3, name: "Freeze card", module: "Cards", platform: "Android" }),
    ];
    const android = selectSessionCases(catalog, { device: "Samsung", pack: "all", module: null });
    expect(android.map((c) => c.testCaseId)).toEqual([1, 3]);
    const ios = selectSessionCases(catalog, { device: "iOS", pack: "all", module: null });
    expect(ios.map((c) => c.testCaseId)).toEqual([2]);
  });

  it("selects one Spira module for an OEM", () => {
    const catalog = [
      caseOf({ key: "1:1", testCaseId: 1, name: "Login", module: "Customer Onboarding & Home Screen", platform: "Android" }),
      caseOf({ key: "1:2", testCaseId: 2, name: "Upgrade tier", module: "Customer Onboarding & Home Screen", platform: "Android" }),
      caseOf({ key: "1:3", testCaseId: 3, name: "Freeze card", module: "Cards", platform: "Android" }),
    ];
    const list = selectSessionCases(catalog, {
      device: "tecno",
      pack: "module",
      module: "Customer Onboarding & Home Screen",
    });
    expect(list.map((c) => c.testCaseId)).toEqual([1, 2]);
    expect(modulesInSession(list)).toEqual([{ module: "Customer Onboarding & Home Screen", count: 2 }]);
  });

  it("builds a 5×3 coverage grid sized to the Spira platform catalogue", () => {
    const store = emptyMatrixStore(24);
    store.releaseId = 99;
    store.releaseLabel = "1.0.0.0.0006";
    store.cases = [
      caseOf({ key: "1:1", testCaseId: 1, name: "Login OTP", module: "Onboarding", platform: "Android" }),
      caseOf({ key: "1:2", testCaseId: 2, name: "Transfer money", module: "Transactions", platform: "Android" }),
      caseOf({ key: "2:3", testCaseId: 3, name: "Login OTP", module: "Onboarding", platform: "iOS" }),
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
      at: "2026-11-05T10:00:00.000Z",
      sessionId: "mx-1",
      releaseId: 99,
    };
    const withResult = upsertResult(store, result);
    const coverage = buildCoverage(withResult, 99);
    expect(coverage.totalCells).toBe(15);
    expect(coverage.executedCells).toBe(1);
    const androidCell = coverage.cells.find((c) => c.device === "Samsung" && c.network === "MTN")!;
    expect(androidCell.planned).toBe(2);
    expect(androidCell.executed).toBe(1);
    expect(androidCell.status).toBe("inProgress");
    const iosCell = coverage.cells.find((c) => c.device === "iOS" && c.network === "MTN")!;
    expect(iosCell.planned).toBe(1);
    expect(iosCell.executed).toBe(0);
  });

  it("counts session progress from cell results", () => {
    const session: MatrixSession = {
      id: "mx-1",
      projectId: 24,
      releaseId: 99,
      releaseLabel: "1.0.0.0.0006",
      device: "itel",
      network: "Glo",
      pack: "all",
      module: null,
      tester: "Ada",
      createdAt: "2026-11-05T09:00:00.000Z",
      updatedAt: "2026-11-05T09:00:00.000Z",
      cases: [
        caseOf({ key: "1:1", testCaseId: 1, name: "Login", module: "Onboarding", platform: "Android" }),
        caseOf({ key: "1:2", testCaseId: 2, name: "Airtime", module: "Transactions", platform: "Android" }),
      ],
    };
    const results: MatrixResult[] = [
      {
        id: resultId("itel", "Glo", "1:1"),
        caseKey: "1:1",
        testCaseId: 1,
        module: "Onboarding",
        device: "itel",
        network: "Glo",
        status: "failed",
        comment: "OTP timeout",
        tester: "Ada",
        at: "2026-11-05T10:00:00.000Z",
        sessionId: "mx-1",
        releaseId: 99,
      },
    ];
    expect(sessionCounts(session, results)).toEqual({
      total: 2,
      executed: 1,
      passed: 0,
      failed: 1,
      blocked: 0,
      caution: 0,
      remaining: 1,
    });
  });

  it("keys app-owned buckets by device × network × module (Spira stays platform-only)", () => {
    expect(matrixBucketKey("iOS", "MTN", "Accounts & Transactions")).toBe("iOS|MTN|accounts & transactions");
    expect(matrixBucketKey("Samsung", "Airtel", "Transfers - Android")).toBe("Samsung|Airtel|transfers");
    expect(prodModuleLabel("Transfers - iOS")).toBe("Transfers");
    expect(isProdMatrixModule("Cards")).toBe(true);
    expect(isProdMatrixModule("Home Screen")).toBe(false);
  });
});
