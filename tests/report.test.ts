import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportDocument } from "@/app/(app)/reports/report-document";
import {
  addSnapshot,
  buildReport,
  classifySet,
  combineOutcomes,
  compareSnapshots,
  decodeShare,
  defaultReportOptions,
  encodeShare,
  folderFamily,
  initialReportOptions,
  levelOf,
  moduleId,
  previousSnapshot,
  previousVersion,
  releaseFamily,
  resolveReportOptions,
  retestState,
  scopeHints,
  setsInScope,
  snapshotOf,
  windowText,
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
  statusId: null,
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

  it("points an empty scope at the releases and folders that hold test sets", () => {
    const scope = { releaseId: 2, folderId: 3 };
    expect(setsInScope(catalog, scope)).toEqual([]);
    const hints = scopeHints(catalog, scope);
    expect(hints.byRelease.map((h) => [h.scope, h.sets])).toEqual([[{ releaseId: 1, folderId: 3 }, 4]]);
    expect(hints.byFolder.map((h) => [h.scope, h.label, h.sets])).toEqual([[{ releaseId: 2, folderId: 1 }, "SIT Cycle 2", 4]]);
    expect(setsInScope(catalog, hints.byFolder[0].scope)).toHaveLength(4);
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

  it("uses the total test plan release from Settings when it exists", () => {
    const releases = [...catalog.releases, { ...catalog.releases[0], releaseId: 9, versionNumber: "1.0.0.0000", label: "1.0.0.0000" }];
    expect(initialReportOptions(releases, 2, 9).baseline.releaseId).toBe(9);
    expect(initialReportOptions(releases, 2, 404).baseline.releaseId).toBe(1);
    expect(initialReportOptions(releases, 2, 2).baseline.releaseId).toBe(1);
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

  it("counts test runs: each case once per platform, without the API stream", () => {
    expect(report.kpis).toMatchObject({ plan: 10, inScope: 8, laterBuilds: 2, executed: 6, stillToRun: 2, added: 2, deferred: 4, modulesInPlan: 3 });
    expect(report.kpis.outcomes).toMatchObject({ passed: 5, failed: 1, notRun: 2 });
    expect(report.kpis.passPct).toBeCloseTo(83.33);
    expect(report.kpis.split).toMatchObject({ plan: { iOS: 6, Android: 4 }, inScope: { iOS: 5, Android: 3 }, executed: { iOS: 3, Android: 3 }, failed: { iOS: 1 } });
    expect(report.kpis.api).toMatchObject({ inScope: 1, executed: 1, passed: 1 });
    expect(report.kpis.spiraRollup).toMatchObject({ passed: 5, failed: 1 });
    const payments = report.modules.find((m) => m.name === "Payments")!;
    expect(payments).toMatchObject({ plan: 7, inScope: 6, laterBuilds: 1, added: 2, executed: 6, failedCases: 1, samePerPlatform: false, streams: ["iOS", "Android"], openDefects: 1, status: "ready" });
    expect(payments.byStream.iOS).toMatchObject({ total: 3, executed: 3 });
    expect(payments.baselineByStream.iOS).toMatchObject({ total: 4, executed: 0 });
    expect(report.modules.find((m) => m.name === "Profile")!.status).toBe("notStarted");
    expect(report.modules.some((m) => m.name === "Accounts")).toBe(false);
    expect(report.laterModules.map((m) => [m.name, m.plan, m.inBuild])).toEqual([["Cards", 1, false]]);
    expect(report.streams).toEqual(["iOS", "Android"]);
  });

  it("compares the scope with the baseline module by module", () => {
    const payments = report.scope.rows.find((r) => r.name === "Payments")!;
    expect(payments).toMatchObject({ baseline: 7, inScope: 6, both: 4, deferred: 3, added: 2 });
    expect(payments.baselineStreams).toEqual({ iOS: 4, Android: 3 });
    expect(report.scope.rows.find((r) => r.name === "Cards")).toMatchObject({ baseline: 1, inScope: 0 });
    expect(report.scope.added.map((c) => c.testCaseId)).toEqual([103]);
  });

  it("compares the cycles on iOS, module by module", () => {
    expect(report.cycle).toMatchObject({ stream: "iOS", baselineName: "SIT Cycle 1", scopedName: "SIT Cycle 2" });
    const named = buildReport(input({ options: options({ baselineName: "Cycle 1", environment: "SIT Cycle 2", phase: "Phase 1" }) }));
    expect(named.cycle).toMatchObject({ baselineName: "Cycle 1", scopedName: "SIT Cycle 2" });
    expect(named.cycle!.rows).toEqual([
      { name: "Payments", before: "Not run (4 planned)", now: "3 run · 1 failed", movement: "New defects found", tone: "bad" },
      { name: "Profile", before: "Not run (2 planned)", now: "Not started", movement: "Not started", tone: "neutral" },
      { name: "Cards", before: "Not planned", now: "Not in Phase 1", movement: "Later build", tone: "neutral" },
    ]);
    expect(named.labels).toEqual({ build: "This build (Phase 1)", name: "Phase 1", short: "Phase 1", named: true, inBuild: "In Phase 1", outside: "Outside Phase 1" });
    expect(named.title).toBe("Project-Simba — Daily SIT Test Report");
    expect(report.title).toBe("Project-Simba — Daily SIT Test Report");
    expect(named.narrative.scopeNote).toBe(
      "SIT Cycle 2 ran Sat 10 – Sun 11 Oct 2026. Test cases were scoped from the full plan (iOS 6 · Android 4, 10 runs) to Phase 1 (iOS 5 · Android 3, 8 runs, including 1 per platform added in testing). This build (Phase 1) is every case in the test sets of release 1.0.0.0002, run on iOS and Android. Cards is not part of Phase 1. The API stream (1 case, 1 executed) is reported separately.",
    );
  });

  it("reads the execution window from the runs, unless it is set", () => {
    expect(report.window).toMatchObject({ first: "2026-10-10T10:00:00Z", last: "2026-10-11T12:30:00Z", text: "Sat 10 – Sun 11 Oct 2026" });
    expect(windowText("2026-09-30T10:00:00Z", "2026-10-02T10:00:00Z")).toBe("Wed 30 Sept – Fri 2 Oct 2026");
    expect(buildReport(input({ options: options({ windowText: "Fri 9 – Sun 11 Oct 2026" }) })).window.text).toBe("Fri 9 – Sun 11 Oct 2026");
  });

  it("takes defects raised in the scoped release or linked to its cases", () => {
    expect(report.defects.rows.map((d) => d.incident.incidentId)).toEqual([258, 259]);
    expect(report.defects).toMatchObject({ open: 1, closed: 1, openCriticalHigh: 0, withinSla: 1 });
    expect(report.defects.rows[0]).toMatchObject({ modules: ["Payments"], testCaseIds: [101], ageDays: 1 });
    expect(report.defects.byPriority.High).toBe(1);
    expect(report.defects.byPriorityInBuild.High).toBe(1);
    expect(report.defects.severityAge.Medium).toEqual([1, 0, 0, 0]);
    expect(report.defects.rows[0]).toMatchObject({ failedRuns: 1, feature: "Payments", phase: "in", rationale: "" });
    expect(report.defects.rows[1].phase).toBeNull();
    expect(report.defects.summary).toBe(
      "2 defects logged in Spira (IN:258 – IN:259), all in Payments and raised on 11 Oct, covering 1 failed case (1 failed run across iOS and Android). 1 open, 1 closed. None open is Critical or High severity; 1 is Critical or High priority.",
    );
  });

  it("applies QA's notes to the defect register", () => {
    const noted = buildReport(
      input({ options: options({ phase: "Phase 1", defectNotes: { "258": { feature: "Bill payments", phase: "out", rationale: "Feature not in Phase 1" } } }) }),
    );
    expect(noted.defects.rows[0]).toMatchObject({ feature: "Bill payments", phase: "out", rationale: "Feature not in Phase 1" });
    expect(noted.defects.byPriorityInBuild.High).toBe(0);
    expect(noted.narrative.actions.find((a) => a.title === "Scope drift in Payments")?.detail).toContain("Bill payments (1)");
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
    expect(report.findings.find((f) => f.check === "Results differ between platforms")?.appliesTo).toBe("Payments");
    const unchecked = buildReport(input({ links: {} }));
    expect(unchecked.failedCases[0].checked).toBe(false);
    expect(unchecked.sources.linksPartial).toBe(true);
  });

  it("flags Spira counts that differ from the cases read", () => {
    const changed = buildReport(input({ results: { ...input().results, 20: [tc(100, PASSED)] } }));
    expect(changed.findings.find((f) => f.check === "Test set counts differ from its cases")?.appliesTo).toBe("Payments - iOS");
  });

  it("writes a headline from the figures", () => {
    expect(report.narrative.headline).toContain("6 of 8 planned test runs have been executed (75.0%) and 83.3% passed");
    expect(report.narrative.headline).toContain("The only failure is in Payments.");
    expect(report.narrative.actions.map((a) => a.title)).toEqual(["Payments quality", "Remaining scope", "Overdue test sets"]);
    expect(report.narrative.why).toEqual([
      "Payments: fully executed (6 runs · pass 83.3% (below 95%) · 1 failed run · 1 open defect).",
      "Profile: 2 cases on iOS not yet started.",
    ]);
    expect(report.readiness).toMatchObject({ ready: 1, atRisk: 0, inProgress: 0, notStarted: 1 });
    expect(report.statusReason).toBe(
      "Three of seven criteria are met (blocked tests, no Critical or High severity defects and defect ageing); execution, pass rate, defect closure and module coverage are not yet met.",
    );
    expect(report.trend.days).toHaveLength(21);
    expect(report.trend.days.at(-2)).toMatchObject({ day: "2026-10-11", executed: 4, failed: 1 });
    expect(report.trend.days.at(-1)!.cumulative).toBe(6);
  });

  it("says when the same cases failed on both platforms", () => {
    const both = buildReport(input({ results: { ...input().results, 21: [tc(100, PASSED, "2026-10-10T12:00:00Z"), tc(101, FAILED, "2026-10-11T12:00:00Z"), tc(103, PASSED)] } }));
    expect(both.modules.find((m) => m.name === "Payments")).toMatchObject({ status: "ready", samePerPlatform: true, failedCases: 1 });
    expect(both.narrative.why[0]).toBe("Payments: fully executed (6 runs · pass 66.7% (below 95%) · 2 failed runs · 1 open defect).");
    expect(both.defects.rows[0].failedRuns).toBe(2);
    expect(both.findings.some((f) => f.check === "Results differ between platforms")).toBe(false);
  });

  it("marks a finished clean module ready, and mid-run work in progress until gates fail", () => {
    const allPassed = {
      ...input().results,
      20: [tc(100, PASSED, "2026-10-10T10:00:00Z"), tc(101, PASSED, "2026-10-11T10:00:00Z"), tc(103, PASSED, "2026-10-11T11:00:00Z")],
      21: [tc(100, PASSED, "2026-10-10T12:00:00Z"), tc(101, PASSED, "2026-10-11T12:00:00Z"), tc(103, PASSED, "2026-10-11T12:30:00Z")],
    };
    const ready = buildReport(input({ results: allPassed, incidents: [], links: {} }));
    expect(ready.modules.find((m) => m.name === "Payments")).toMatchObject({ status: "ready", openDefects: 0, checks: { fullyRun: true, passOk: true, noBlocked: true } });
    expect(ready.readiness).toMatchObject({ ready: 1, atRisk: 0, inProgress: 0, notStarted: 1 });

    const outOfScope = buildReport(
      input({
        results: allPassed,
        options: options({ defectNotes: { "258": { feature: "Bill payments", phase: "out", rationale: "Not in Phase 1" } } }),
      }),
    );
    expect(outOfScope.modules.find((m) => m.name === "Payments")).toMatchObject({ status: "ready", openDefects: 1 });

    const midRun = buildReport(
      input({
        results: {
          ...allPassed,
          20: [tc(100, PASSED, "2026-10-10T10:00:00Z"), tc(101, FAILED, "2026-10-11T10:00:00Z"), tc(103, null)],
        },
        incidents: [],
        links: { 101: [] },
      }),
    );
    expect(midRun.modules.find((m) => m.name === "Payments")).toMatchObject({ status: "inProgress", stillToRun: 1, outcomes: { failed: 1 } });
    expect(midRun.readiness.inProgress).toBe(1);
  });

  it("takes this build from the release's test sets, and modules only in the baseline as later builds", () => {
    const report = buildReport(input({ options: options({ phase: "Phase 1" }) }));
    expect(report.kpis).toMatchObject({ plan: 10, inScope: 8, laterBuilds: 2 });
    expect(report.laterModules.map((m) => m.name)).toEqual(["Cards"]);
    expect(report.narrative.scopeNote).toContain("This build (Phase 1) is every case in the test sets of release 1.0.0.0002, run on iOS and Android.");
    expect(report.narrative.scopeNote).toContain("Cards is not part of Phase 1.");
  });

  it("reads whole releases for each report type", () => {
    const setup = options({ scoped: { releaseId: 2, folderId: 1 }, baseline: { releaseId: 1, folderId: 3 }, environment: "SIT Cycle 2", baselineName: "Cycle 1" });
    expect(resolveReportOptions(setup)).toMatchObject({ scoped: { releaseId: 2, folderId: null }, baseline: { releaseId: 1, folderId: null }, environment: "SIT Cycle 2" });
    expect(resolveReportOptions({ ...setup, kind: "build" })).toMatchObject({ scoped: { releaseId: 2, folderId: null }, baseline: { releaseId: null, folderId: null } });
    expect(resolveReportOptions({ ...setup, kind: "plan" })).toMatchObject({ scoped: { releaseId: 1, folderId: null }, baseline: { releaseId: null, folderId: null }, environment: "Cycle 1" });
  });

  it("reports this build alone, or the total test plan alone", () => {
    const build = buildReport(input({ options: resolveReportOptions(options({ kind: "build", phase: "Phase 1" })) }));
    expect(build).toMatchObject({ kind: "build", hasBaseline: false, scopedName: "SIT Cycle 2" });
    expect(build.kpis).toMatchObject({ plan: 8, inScope: 8 });
    expect(build.labels.build).toBe("This build (Phase 1)");

    const plan = buildReport(input({ options: resolveReportOptions(options({ kind: "plan", phase: "Phase 1" })) }));
    expect(plan).toMatchObject({ kind: "plan", hasBaseline: false, scopedName: "SIT Cycle 1", scopedLabel: "1.0.0.0001" });
    expect(plan.kpis).toMatchObject({ plan: 10, inScope: 10, executed: 0 });
    expect(plan.labels).toMatchObject({ build: "Total test plan", named: false, short: "Plan" });
    expect(plan.narrative.scopeNote).toContain("Total test plan is every case in the test sets of release 1.0.0.0001");
    const html = renderToStaticMarkup(createElement(ReportDocument, { report: plan, changes: null, siteUrl: null }));
    expect(html.match(/report-page/g)).toHaveLength(4);
    expect(html).toContain("1. Total test plan: by module");
    expect(html).not.toContain("Total test plan vs");
  });

  it("works without a baseline", () => {
    const alone = buildReport(input({ options: options({ baseline: { releaseId: null, folderId: null } }) }));
    expect(alone.hasBaseline).toBe(false);
    expect(alone.kpis).toMatchObject({ plan: 8, inScope: 8, laterBuilds: 0, added: 0 });
    expect(alone.cycle).toBeNull();
    expect(alone.findings.some((f) => f.check === "Cases in scope but not in the baseline")).toBe(false);
  });
});

describe("report document", () => {
  it("renders the four template pages, and the appendix when asked", () => {
    const render = (patch: Partial<ReportOptions>) =>
      renderToStaticMarkup(createElement(ReportDocument, { report: buildReport(input({ options: options(patch) })), changes: null, siteUrl: null }));
    const html = render({ environment: "SIT Cycle 2", phase: "Phase 1", baselineName: "Cycle 1" });
    expect(html.match(/report-page/g)).toHaveLength(4);
    for (const text of [
      "OVERALL STATUS: RED",
      "Total test plan",
      "This build (Phase 1)",
      "1. Total test plan vs Phase 1: by module",
      "Cards (not in Phase 1)",
      "2. Readiness against SIT exit criteria",
      "3a. Test outcome by module",
      "3b. Module readiness for UAT",
      "3c. Change since Cycle 1 (iOS test sets)",
      "4. Defects and retesting",
      "4d. Defect register: severity and priority",
      "4e. Open defects",
      "Open defects",
      "Key risks and actions",
      "Page 4 / 4",
    ])
      expect(html).toContain(text.replace("&", "&amp;"));
    expect(html).toContain("1 open");
    expect(render({ appendix: true }).match(/report-page/g)).toHaveLength(5);
  });
});

describe("report share links", () => {
  it("carries the report's setup and nothing else", () => {
    const setup = options({ title: "Simba — Daily SIT Report", notes: "Wallet is next", defectNotes: { "258": { feature: "Wallet", phase: "out", rationale: "Phase 2" } } });
    const link = encodeShare(24, { ...setup, scopeSource: "drafts" } as ReportOptions);
    expect(link).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(link)).toEqual({ projectId: 24, options: setup });
  });

  it("keeps the report type, and reads older links as the comparison report", () => {
    expect(decodeShare(encodeShare(24, options({ kind: "plan" })))?.options.kind).toBe("plan");
    const older: Partial<ReportOptions> = options();
    delete older.kind;
    expect(decodeShare(encodeShare(24, older as ReportOptions))?.options.kind).toBe("buildVsPlan");
  });

  it("refuses text that is not a report link", () => {
    expect(decodeShare("not-a-link")).toBeNull();
    expect(decodeShare(btoa(JSON.stringify({ p: 24, o: { title: "x" } })))).toBeNull();
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

describe("report Excel shaping", () => {
  it("builds a cover-style Summary grid with key sections", async () => {
    const { buildReportSummaryGrid, fitSheetColumns } = await import("@/lib/client/report");
    const grid = buildReportSummaryGrid(buildReport(input()));
    expect(grid[0]).toEqual(["Report", expect.any(String)]);
    expect(grid.some((r) => r[0] === "Key figures")).toBe(true);
    expect(grid.some((r) => r[0] === "Narrative")).toBe(true);
    expect(grid.some((r) => r[0] === "Pass rate")).toBe(true);

    const sheet: { "!cols"?: Array<{ wch: number }> } = {};
    fitSheetColumns(sheet, [
      { Module: "Payments", "Pass %": "80%" },
      { Module: "Customer Onboarding & Home Screen", "Pass %": "100%" },
    ]);
    expect(sheet["!cols"]?.[0].wch).toBeGreaterThan(10);
    expect(sheet["!cols"]?.[1].wch).toBeGreaterThanOrEqual(8);
  });
});
