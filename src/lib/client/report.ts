import {
  addSnapshot,
  defaultReportOptions,
  formatPct,
  LEVELS,
  MAX_LINKED_CASES,
  MAX_REPORT_LINKS,
  MAX_REPORT_SETS,
  MODULE_STATUS_LABEL,
  OUTCOME_LABEL,
  OUTCOMES,
  RETEST_LABEL,
  setsInScope,
  snapshotOf,
  type Report,
  type ReportInput,
  type ReportOptions,
  type ReportSnapshot,
} from "@/lib/domain/report";
import { EXECUTION_STATUS } from "@/lib/domain/execution";
import type { ReportCase, ReportCatalog, ReportIncident, TestSetMapping } from "@/lib/domain/types";
import { api } from "./api";
import { readItem, writeItem } from "./storage";

export async function loadCatalog(projectId: number, signal?: AbortSignal): Promise<ReportCatalog> {
  return api<ReportCatalog>("/api/reports/catalog", { method: "POST", body: { projectId }, signal });
}

const optionsKey = (projectId: number) => `report-options:${projectId}`;

/** Null until the report has been set up once for this project in this browser. */
export function loadReportOptions(projectId: number): ReportOptions | null {
  const stored = readItem<Partial<ReportOptions>>(optionsKey(projectId));
  if (!stored) return null;
  const defaults = defaultReportOptions();
  return { ...defaults, ...stored, targets: { ...defaults.targets, ...stored.targets }, defectNotes: { ...stored.defectNotes } };
}

export function saveReportOptions(projectId: number, options: ReportOptions): void {
  writeItem(optionsKey(projectId), options);
}

const snapshotKey = (projectId: number, options: ReportOptions) =>
  `report-snapshots:${projectId}:${options.scoped.releaseId ?? "none"}:${options.scoped.folderId ?? "all"}`;

export function loadSnapshots(projectId: number, options: ReportOptions): ReportSnapshot[] {
  return readItem<ReportSnapshot[]>(snapshotKey(projectId, options)) ?? [];
}

/** Keeps today's figures so the next report can show what changed. Returns the snapshots before this one. */
export function recordSnapshot(report: Report, options: ReportOptions): ReportSnapshot[] {
  const before = loadSnapshots(report.projectId, options);
  try {
    writeItem(snapshotKey(report.projectId, options), addSnapshot(before, snapshotOf(report)));
  } catch {
    // storage full: the report still shows, only the history is not kept
  }
  return before;
}

export interface ReportProgress {
  step: string;
  done: number;
  total: number;
}

async function inBatches<T>(items: T[], size: number, workers: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, batches.length) }, async () => {
      while (next < batches.length) await run(batches[next++]);
    }),
  );
}

const LINK_STATUSES = new Set<number>([EXECUTION_STATUS.failed, EXECUTION_STATUS.blocked, EXECUTION_STATUS.caution]);

/**
 * Reads everything the report needs from Spira (through the server, read-only): the cases of every
 * test set in both scopes, the project's incidents, and the incidents linked to each failed, blocked
 * or caution case in scope.
 */
export async function readReportData(input: {
  catalog: ReportCatalog;
  options: ReportOptions;
  mappings: TestSetMapping[];
  onProgress: (progress: ReportProgress) => void;
  signal?: AbortSignal;
}): Promise<ReportInput> {
  const { catalog, options, signal } = input;
  const projectId = catalog.projectId;
  const scopedSets = setsInScope(catalog, options.scoped);
  const baselineSets = setsInScope(catalog, options.baseline);
  const setIds = [...new Set([...scopedSets, ...baselineSets].map((s) => s.testSetId))];

  const incidentsRead = api<{ incidents: ReportIncident[]; complete: boolean }>("/api/reports/incidents", { method: "POST", body: { projectId }, signal });
  incidentsRead.catch(() => undefined);

  const results: Record<number, ReportCase[]> = {};
  input.onProgress({ step: "Reading test sets", done: 0, total: setIds.length });
  await inBatches(setIds, MAX_REPORT_SETS, 3, async (batch) => {
    const out = await api<{ results: Record<string, ReportCase[]> }>("/api/reports/results", { method: "POST", body: { projectId, testSetIds: batch }, signal });
    for (const [id, cases] of Object.entries(out.results)) results[Number(id)] = cases;
    input.onProgress({ step: "Reading test sets", done: Object.keys(results).length, total: setIds.length });
  });

  // Failed cases first, so the link check covers them before blocked and caution ones.
  const failed = new Set<number>();
  const others = new Set<number>();
  for (const set of scopedSets) {
    for (const c of results[set.testSetId] ?? []) {
      if (c.statusId === EXECUTION_STATUS.failed) failed.add(c.testCaseId);
      else if (c.statusId !== null && LINK_STATUSES.has(c.statusId)) others.add(c.testCaseId);
    }
  }
  const toLink = [...failed, ...[...others].filter((id) => !failed.has(id))].slice(0, MAX_LINKED_CASES);

  const links: Record<number, number[]> = {};
  const linked = new Map<number, ReportIncident>();
  input.onProgress({ step: "Checking defects linked to failures", done: 0, total: toLink.length });
  await inBatches(toLink, MAX_REPORT_LINKS, 3, async (batch) => {
    const out = await api<{ links: Record<string, number[]>; incidents: ReportIncident[] }>("/api/reports/links", {
      method: "POST",
      body: { projectId, testCaseIds: batch },
      signal,
    });
    for (const [id, incidentIds] of Object.entries(out.links)) links[Number(id)] = incidentIds;
    for (const incident of out.incidents) linked.set(incident.incidentId, incident);
    input.onProgress({ step: "Checking defects linked to failures", done: Object.keys(links).length, total: toLink.length });
  });

  input.onProgress({ step: "Reading incidents", done: 0, total: 1 });
  const { incidents, complete } = await incidentsRead;
  const all = new Map(incidents.map((i) => [i.incidentId, i]));
  for (const [id, incident] of linked) all.set(id, incident);

  return {
    catalog,
    options,
    mappings: input.mappings,
    results,
    incidents: [...all.values()],
    incidentsComplete: complete,
    links,
    generatedAt: new Date().toISOString(),
  };
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "report";
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** The report as a workbook: one sheet per section, every figure as read from Spira. */
export async function exportReportWorkbook(report: Report, siteUrl: string | null): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const link = (path: string) => (siteUrl ? `${siteUrl}/${report.projectId}/${path}` : "");
  const add = (name: string, rows: object[]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ "": "Nothing to show" }]), name);
  const k = report.kpis;

  add("Summary", [
    { Item: "Report", Value: report.title },
    { Item: "Project", Value: `${report.projectName} (${report.projectId})` },
    { Item: "Cycle", Value: report.environment },
    { Item: "In scope", Value: report.scopedLabel },
    { Item: "Baseline", Value: report.baselineLabel },
    { Item: "Read from Spira", Value: report.generatedAt },
    { Item: "Prepared by", Value: report.preparedBy },
    { Item: "Go-live", Value: report.goLive ?? "" },
    { Item: "Overall status", Value: report.status.toUpperCase() },
    { Item: "Status reason", Value: report.statusReason },
    { Item: "Executions", Value: report.window.text ?? "" },
    { Item: "Counted as", Value: "Test runs: each case once per platform it is planned on" },
    { Item: "Total test plan (runs)", Value: k.plan },
    { Item: `${report.labels.build} (runs)`, Value: k.inScope },
    { Item: "Later builds (runs)", Value: k.laterBuilds },
    { Item: "Executed", Value: k.executed },
    { Item: "Executed %", Value: formatPct(k.execPct) },
    ...OUTCOMES.map((o) => ({ Item: OUTCOME_LABEL[o], Value: k.outcomes[o] })),
    { Item: "Still to run", Value: k.stillToRun },
    { Item: "Pass rate", Value: formatPct(k.passPct) },
    ...report.streams.map((s) => ({
      Item: s,
      Value: `${k.split.inScope[s] ?? 0} in scope, ${k.split.executed[s] ?? 0} executed, ${k.split.passed[s] ?? 0} passed, ${k.split.failed[s] ?? 0} failed`,
    })),
    { Item: "Added in testing (runs)", Value: k.added },
    { Item: `${report.baselineName} pass rate`, Value: formatPct(k.baseline.passPct) },
    { Item: "API cases (not counted above)", Value: k.api.inScope },
    { Item: "Open defects", Value: report.defects.open },
    { Item: "Summary", Value: report.narrative.headline },
    { Item: "Why each module has its status", Value: report.narrative.why.join(" ") },
    { Item: "Scope note", Value: report.narrative.scopeNote },
    { Item: "Data note", Value: report.narrative.dataNote },
    { Item: "QA notes", Value: report.notes },
  ]);
  add(
    "Modules",
    [...report.modules, ...report.laterModules].map((m) => ({
      Module: m.name,
      [report.labels.inBuild]: m.inBuild ? "Yes" : "No",
      Platforms: m.streams.join(", "),
      "Total plan": m.plan,
      [report.labels.build]: m.inScope,
      "Later builds": m.laterBuilds,
      "Added": m.added,
      Executed: m.executed,
      "Exec %": formatPct(m.execPct),
      ...Object.fromEntries(OUTCOMES.map((o) => [OUTCOME_LABEL[o], m.outcomes[o]])),
      "Still to run": m.stillToRun,
      "Pass %": formatPct(m.passPct),
      "Failed cases": m.failedCases,
      "Open defects": m.openDefects,
      Status: m.inBuild ? MODULE_STATUS_LABEL[m.status] : "Later build",
      ...Object.fromEntries(report.streams.map((s) => [`${s} run`, m.byStream[s] ? `${m.byStream[s]!.executed} / ${m.byStream[s]!.total}` : ""])),
      "Last run": day(m.lastRun),
    })),
  );
  add("Exit criteria", report.criteria.map((c, i) => ({ "#": i + 1, Criterion: c.label, Target: c.target, Actual: c.actual, Status: c.met ? "Met" : "Not met" })));
  if (report.cycle) {
    const cycle = report.cycle;
    add(
      "Cycle change",
      cycle.rows.map((r) => ({ Module: r.name, [`${cycle.baselineName} (${cycle.stream})`]: r.before, [`${cycle.scopedName} (${cycle.stream})`]: r.now, Movement: r.movement })),
    );
  }
  add("Risks and actions", report.narrative.actions.map((a) => ({ Risk: a.title, Detail: a.detail, Action: a.action })));
  add(
    "Scope",
    report.scope.rows.map((r) => ({
      Module: r.name,
      Baseline: r.baseline,
      "In scope": r.inScope,
      "In both": r.both,
      "Baseline only": r.deferred,
      "Added": r.added,
      "Baseline covered": formatPct(r.coveragePct),
      ...Object.fromEntries(report.scope.streams.flatMap((s) => [[`${s} baseline`, r.baselineStreams[s] ?? 0], [`${s} in scope`, r.scopedStreams[s] ?? 0]])),
    })),
  );
  add(
    "Defects",
    report.defects.rows.map((d) => ({
      ID: `IN:${d.incident.incidentId}`,
      Defect: d.incident.name,
      Status: d.incident.status ?? "",
      Open: d.incident.open ? "Yes" : "No",
      Severity: d.severity,
      Priority: d.priority,
      Retest: RETEST_LABEL[d.retest],
      "Age (days)": d.ageDays ?? "",
      Feature: d.feature,
      Scope: d.phase === "in" ? report.labels.inBuild : d.phase === "out" ? report.labels.outside : d.phase === "tbc" ? "To confirm" : "",
      Rationale: d.rationale,
      Modules: d.modules.join(", "),
      "Test cases": d.testCaseIds.map((id) => `TC:${id}`).join(", "),
      "Failed runs": d.failedRuns,
      Release: d.incident.detectedRelease ?? "",
      Raised: day(d.incident.createdAt),
      Owner: d.incident.owner ?? "",
      Link: link(`Incident/${d.incident.incidentId}.aspx`),
    })),
  );
  add(
    "Defects by severity",
    LEVELS.map((l) => ({
      Level: l,
      "0–2 days": report.defects.severityAge[l][0],
      "3–5": report.defects.severityAge[l][1],
      "6–10": report.defects.severityAge[l][2],
      "> 10": report.defects.severityAge[l][3],
      "Open by priority": report.defects.byPriority[l],
      [`Open by priority, ${report.labels.inBuild.toLowerCase()}`]: report.defects.byPriorityInBuild[l],
    })),
  );
  add(
    "Failed cases",
    report.failedCases.map((c) => ({
      "Test case": `TC:${c.testCaseId}`,
      Name: c.name,
      Module: c.module,
      "Failed on": c.streams.join(", "),
      Defects: c.checked ? c.incidentIds.map((id) => `IN:${id}`).join(", ") || "None linked" : "Not checked",
      Link: link(`TestCase/${c.testCaseId}.aspx`),
    })),
  );
  add("Data checks", report.findings.map((f) => ({ Severity: f.severity, Check: f.check, "Applies to": f.appliesTo, Detail: f.detail })));
  const setRow = (scope: string) => (r: Report["testSets"][number]) => ({
    Scope: scope,
    "Test set": r.set.name,
    ID: `TX:${r.set.testSetId}`,
    Module: r.module,
    Platform: r.stream,
    Folder: r.folder,
    Release: r.set.releaseVersion ?? "",
    Status: r.set.status ?? "",
    Owner: r.set.owner ?? "",
    Planned: day(r.set.plannedDate),
    "Last executed": day(r.set.executionDate),
    Passed: r.set.counts.passed,
    Failed: r.set.counts.failed,
    Blocked: r.set.counts.blocked,
    Caution: r.set.counts.caution,
    "Not run": r.set.counts.notRun,
    "N/A": r.set.counts.notApplicable,
    "Spira total": r.spiraTotal,
    "Cases read": r.read ?? "",
    Overdue: r.overdue ? "Yes" : "",
    Link: link(`TestSet/${r.set.testSetId}.aspx`),
  });
  add("Test sets", [...report.testSets.map(setRow("In scope")), ...report.baselineSets.map(setRow("Baseline"))]);
  add("Added cases", report.scope.added.map((c) => ({ "Test case": `TC:${c.testCaseId}`, Name: c.name, Module: c.module })));
  add("Baseline only", report.scope.deferred.map((c) => ({ "Test case": `TC:${c.testCaseId}`, Name: c.name, Module: c.module })));
  add("Trend", report.trend.days.map((d) => ({ Day: d.day, "Runs last executed": d.executed, "Of which failed": d.failed, "Executed so far": d.cumulative })));

  XLSX.writeFile(wb, `${safeFileName(`${report.title} ${day(report.generatedAt)}`)}.xlsx`);
}
