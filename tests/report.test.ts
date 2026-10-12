import { describe, expect, it } from "vitest";
import {
  addSnapshot,
  buildReport,
  classifySet,
  combineOutcomes,
  compareSnapshots,
  defaultReportOptions,
  folderFamily,
  initialReportOptions,
  levelOf,
  moduleId,
  previousSnapshot,
  previousVersion,
  releaseFamily,
  retestState,
  setsInScope,
  snapshotOf,
  type ReportInput,
  type ReportOptions,
} from "@/lib/domain/report";
import type { ReportCase, ReportCatalog, ReportIncident, ReportTestSet, SpiraRelease } from "@/lib/domain/types";

const release = (releaseId: number, versionNumber: string, depth = 0): SpiraRelease => ({
  releaseId,
  name: "",
  versionNumber,
  label: versionNumber,
  depth,
  active: true,
  type: null,
});

const counts = { passed: 0, failed: 0, caution: 0, blocked: 0, notRun: 0, notApplicable: 0 };

const set = (testSetId: number, name: string, releaseId: number, folderId: number | null = 1, extra: Partial<ReportTestSet> = {}): ReportTestSet => ({
  testSetId,
  name,
  folderId,
  releaseId,
  releaseVersion: null,
  status: null,
  owner: null,
  plannedDate: null,
  executionDate: null,
  counts,
  ...extra,
});

const tc = (testCaseId: number, statusId: number | null, executionDate: string | null = null): ReportCase => ({
  testSetTestCaseId: testCaseId * 10,
  testCaseId,
  name: `Case ${testCaseId}`,
  statusId,
  executionDate,
  priority: null,
});

const incident = (incidentId: number, extra: Partial<ReportIncident> = {}): ReportIncident => ({
  incidentId,
  name: `Defect ${incidentId}`,
  status: "New",
  open: true,
  severity: "3 - Medium",
  priority: "2 - High",
  type: "Bug",
  detectedReleaseId: 2,
  detectedRelease: "1.0.0.0002",
  createdAt: "2026-10-11T09:00:00.000Z",
  closedAt: null,
  owner: null,
  opener: null,
  ...extra,
});

const PASSED = 2;
const FAILED = 1;

// Release 1.0.0.0001 is the baseline (every case); 1.0.0.0002 is the scope, with a sprint under it.
const catalog: ReportCatalog = {
  projectId: 24,
  projectName: "Project-Simba",
  releases: [release(1, "1.0.0.0001"), release(2, "1.0.0.0002"), release(3, "1.0.0.0002.1", 1), release(4, "2.0")],
  folders: [
    { folderId: 1, parentId: null, name: "SIT Cycle 2" },
    { folderId: 2, parentId: 1, name: "API" },
    { folderId: 3, parentId: null, name: "SIT Cycle 1" },
  ],
  testSets: [
    set(10, "Payments - iOS", 1, 3),
    set(11, "Payments - Android", 1, 3),
    set(12, "Profile-iOS", 1, 3),
    set(13, "Cards - Android", 1, 3),
    set(20, "Payments - iOS", 2, 1, { counts: { ...counts, passed: 2, failed: 1 } }),
    set(21, "Payments - Android", 3, 1, { counts: { ...counts, passed: 3 } }),
    set(22, "Profile-iOS", 2, 1, { plannedDate: "2026-10-01T00:00:00.000Z", counts: { ...counts, notRun: 2 } }),
    set(23, "Accounts", 2, 2, { counts: { ...counts, passed: 1 } }),
  ],
  readAt: "2026-10-12T08:00:00.000Z",
};

function options(patch: Partial<ReportOptions> = {}): ReportOptions {
  return { ...defaultReportOptions(), baseline: { releaseId: 1, folderId: null }, scoped: { releaseId: 2, folderId: null }, ...patch };
}

function input(patch: Partial<ReportInput> = {}): ReportInput {
  return {
    catalog,
    options: options(),
    mappings: [],
    results: {
      10: [tc(100, null), tc(101, null), tc(102, null), tc(105, null)],
      11: [tc(100, null), tc(101, null), tc(102, null)],
      12: [tc(200, null), tc(201, null)],
      13: [tc(300, null)],
      20: [tc(100, PASSED, "2026-10-10T10:00:00Z"), tc(101, FAILED, "2026-10-11T10:00:00Z"), tc(103, PASSED, "2026-10-11T11:00:00Z")],
      21: [tc(100, PASSED, "2026-10-10T12:00:00Z"), tc(101, PASSED, "2026-10-11T12:00:00Z"), tc(103, PASSED, "2026-10-11T12:30:00Z")],
      22: [tc(200, null), tc(201, null)],
      23: [tc(400, PASSED, "2026-10-09T08:00:00Z")],
    },
    incidents: [incident(258), incident(259, { open: false, status: "Closed", detectedReleaseId: 2 }), incident(300, { detectedReleaseId: 4 })],
    incidentsComplete: true,
    links: { 101: [258] },
    generatedAt: "2026-10-12T09:00:00.000Z",
    ...patch,
  };
}

describe("report scope", () => {
  it("includes a release's sprints and a folder's subfolders", () => {
    expect([...releaseFamily(catalog.releases, 2)]).toEqual([2, 3]);
    expect([...folderFamily(catalog.folders, 1)].sort()).toEqual([1, 2]);
    expect(setsInScope(catalog, { releaseId: 2, folderId: null }).map((s) => s.testSetId)).toEqual([20, 21, 22, 23]);
    expect(setsInScope(catalog, { releaseId: 2, folderId: 2 }).map((s) => s.testSetId)).toEqual([23]);
    expect(setsInScope(catalog, { releaseId: null, folderId: null })).toEqual([]);
  });

  it("compares a release with the one before it by default", () => {
    expect(previousVersion("1.0.0.0002")).toBe("1.0.0.0001");
    expect(previousVersion("1.0.0.0.0010")).toBe("1.0.0.0.0009");
    expect(previousVersion("1.0.0.0001")).toBeNull();
    const first = initialReportOptions(catalog.releases, 2);
    expect(first.scoped.releaseId).toBe(2);
    expect(first.baseline.releaseId).toBe(1);
    expect(initialReportOptions(catalog.releases, null).scoped.releaseId).toBeNull();
  });

  it("reads the module and platform from the test set name and folder", () => {
    expect(classifySet(set(1, "Cards - Android", 1), catalog.folders, [])).toEqual({ module: "Cards", stream: "Android" });
    expect(classifySet(set(1, "Home Screen- iOS", 1), catalog.folders, [])).toEqual({ module: "Home Screen", stream: "iOS" });
    expect(classifySet(set(1, "Accounts", 1, 2), catalog.folders, [])).toEqual({ module: "Accounts", stream: "API" });
    expect(classifySet(set(1, "API", 1, null), catalog.folders, [])).toEqual({ module: "API", stream: "API" });
    expect(classifySet(set(1, "Payments API", 1, null), catalog.folders, [])).toEqual({ module: "Payments", stream: "API" });
    expect(
      classifySet(set(7, "Odd name", 1, null), catalog.folders, [{ id: "m", module: "Transfers", testSetId: 7, testSetName: "Odd name", platform: "iOS" }]),
    ).toEqual({ module: "Transfers", stream: "iOS" });
    expect(moduleId("Notifications")).toBe(moduleId("Notification"));
  });

  it("combines a case's platforms into one result", () => {
    expect(combineOutcomes(["passed", "passed"])).toBe("passed");
    expect(combineOutcomes(["passed", "notRun"])).toBe("notRun");
    expect(combineOutcomes(["failed", "notRun"])).toBe("failed");
    expect(combineOutcomes(["caution", "passed"])).toBe("caution");
    expect(combineOutcomes(["notApplicable", "notApplicable"])).toBe("notApplicable");
  });

  it("reads severity names and retest states", () => {
    expect(levelOf("1 - Critical")).toBe("Critical");
    expect(levelOf("2 - High")).toBe("High");
    expect(levelOf("P3")).toBe("Medium");
    expect(levelOf(null)).toBe("Not set");
    expect(retestState(incident(1, { status: "Resolved" }))).toBe("retest");
    expect(retestState(incident(1, { status: "Reopen" }))).toBe("reopened");
    expect(retestState(incident(1, { open: false }))).toBe("closed");
    expect(retestState(incident(1))).toBe("awaiting");
  });
});

describe("buildReport", () => {
  const report = buildReport(input());

  it("counts each case once per module, across platforms", () => {
    expect(report.kpis).toMatchObject({ baseline: 7, inScope: 6, executed: 4, added: 2, deferred: 3 });
    expect(report.kpis.outcomes).toMatchObject({ passed: 3, failed: 1, notRun: 2 });
    expect(report.kpis.passPct).toBeCloseTo(75);
    const payments = report.modules.find((m) => m.name === "Payments")!;
    expect(payments).toMatchObject({ baseline: 4, inScope: 3, added: 1, executed: 3, streams: ["iOS", "Android"], openDefects: 1, status: "atRisk" });
    expect(payments.byStream.iOS).toMatchObject({ total: 3, executed: 3 });
    expect(report.modules.find((m) => m.name === "Profile")!.status).toBe("notStarted");
    expect(report.modules.find((m) => m.name === "Accounts")).toMatchObject({ status: "ready", streams: ["API"] });
    expect(report.streams).toEqual(["iOS", "Android", "API"]);
  });

  it("compares the scope with the baseline module by module", () => {
    const payments = report.scope.rows.find((r) => r.name === "Payments")!;
    expect(payments).toMatchObject({ baseline: 4, inScope: 3, both: 2, deferred: 2, added: 1 });
    expect(payments.baselineStreams).toEqual({ iOS: 4, Android: 3 });
    expect(report.scope.rows.find((r) => r.name === "Cards")).toMatchObject({ baseline: 1, inScope: 0 });
    expect(report.scope.added.map((c) => c.testCaseId).sort()).toEqual([103, 400]);
  });

  it("takes defects raised in the scoped release or linked to its cases", () => {
    expect(report.defects.rows.map((d) => d.incident.incidentId)).toEqual([258, 259]);
    expect(report.defects).toMatchObject({ open: 1, closed: 1, openCriticalHigh: 0, withinSla: 1 });
    expect(report.defects.rows[0]).toMatchObject({ modules: ["Payments"], testCaseIds: [101], ageDays: 1 });
    expect(report.defects.byPriority.High).toBe(1);
    expect(report.defects.severityAge.Medium).toEqual([1, 0, 0, 0]);
  });

  it("judges the exit criteria and the overall status", () => {
    const met = Object.fromEntries(report.criteria.map((c) => [c.label, c.met]));
    expect(met["Planned test cases executed"]).toBe(false);
    expect(met["Pass rate of executed tests"]).toBe(false);
    expect(met["Blocked test cases"]).toBe(true);
    expect(met["Open Critical / High severity defects"]).toBe(true);
    expect(report.autoStatus).toBe("red");
    expect(buildReport(input({ options: options({ status: "amber" }) })).status).toBe("amber");
  });

  it("flags failures without a defect and overdue sets", () => {
    const withoutLinks = buildReport(input({ links: { 101: [] } }));
    expect(withoutLinks.defects.failedWithoutDefect.map((c) => c.testCaseId)).toEqual([101]);
    expect(withoutLinks.findings.find((f) => f.check === "Failed results with no linked defect")).toMatchObject({ severity: "High", appliesTo: "Payments" });
    expect(report.findings.find((f) => f.check === "Test sets past their planned date")?.appliesTo).toBe("Profile-iOS");
    expect(report.findings.find((f) => f.check === "Modules not started")?.appliesTo).toBe("Profile");
    const unchecked = buildReport(input({ links: {} }));
    expect(unchecked.failedCases[0].checked).toBe(false);
    expect(unchecked.sources.linksPartial).toBe(true);
  });

  it("flags Spira counts that differ from the cases read", () => {
    const changed = buildReport(input({ results: { ...input().results, 20: [tc(100, PASSED)] } }));
    expect(changed.findings.find((f) => f.check === "Test set counts differ from its cases")?.appliesTo).toBe("Payments - iOS");
  });

  it("writes a headline from the figures", () => {
    expect(report.narrative.headline).toContain("4 of 6 in-scope test cases have been executed (66.7%)");
    expect(report.narrative.headline).toContain("The only failure is in Payments.");
    expect(report.narrative.actions.map((a) => a.title)).toContain("Payments quality");
    expect(report.trend.days).toHaveLength(21);
    expect(report.trend.days.at(-2)).toMatchObject({ day: "2026-10-11", executed: 2, failed: 1 });
    expect(report.trend.days.at(-1)!.cumulative).toBe(4);
  });

  it("works without a baseline", () => {
    const alone = buildReport(input({ options: options({ baseline: { releaseId: null, folderId: null } }) }));
    expect(alone.hasBaseline).toBe(false);
    expect(alone.kpis.baseline).toBe(0);
    expect(alone.findings.some((f) => f.check === "Cases in scope but not in the baseline")).toBe(false);
  });
});

describe("report snapshots", () => {
  it("shows what moved since an earlier day's report", () => {
    const today = buildReport(input());
    const yesterday = { ...snapshotOf(today), at: "2026-10-11T09:00:00.000Z" };
    yesterday.modules = yesterday.modules.map((m) => (m.name === "Payments" ? { ...m, executed: 1, failed: 0, passed: 1 } : m));
    const kept = addSnapshot(addSnapshot([], yesterday), snapshotOf(today));
    expect(kept).toHaveLength(2);
    expect(addSnapshot(kept, snapshotOf(today))).toHaveLength(2);
    const previous = previousSnapshot(kept, today)!;
    expect(previous.at).toBe(yesterday.at);
    const rows = compareSnapshots(previous, snapshotOf(today));
    expect(rows.find((r) => r.name === "Payments")).toMatchObject({ movement: "New risk", tone: "bad" });
    expect(rows.find((r) => r.name === "Profile")).toMatchObject({ movement: "No change" });
  });
});
