import { EXECUTION_STATUS } from "./execution";
import { guessMapping } from "./settings";
import { moduleKey } from "./test-set-suggest";
import type { ReportCase, ReportCatalog, ReportFolder, ReportIncident, ReportTestSet, SpiraRelease, TestSetMapping } from "./types";

/** Test sets read per request, and test cases whose incidents are looked up per request. */
export const MAX_REPORT_SETS = 10;
export const MAX_REPORT_LINKS = 25;
/** Failed and blocked cases whose linked incidents are looked up; beyond this the link check is partial. */
export const MAX_LINKED_CASES = 400;

export const STREAMS = ["iOS", "Android", "API", "Web", "Other"] as const;
export type Stream = (typeof STREAMS)[number];

export const OUTCOMES = ["passed", "failed", "blocked", "caution", "notRun", "notApplicable"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type OutcomeCounts = Record<Outcome, number>;

export const OUTCOME_LABEL: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  caution: "Caution",
  notRun: "Not run",
  notApplicable: "N/A",
};

export type RagStatus = "green" | "amber" | "red";
export type ModuleStatus = "ready" | "atRisk" | "inProgress" | "notStarted";

export const MODULE_STATUS_LABEL: Record<ModuleStatus, string> = {
  ready: "Ready",
  atRisk: "At risk",
  inProgress: "In progress",
  notStarted: "Not started",
};

export interface ReportScope {
  releaseId: number | null;
  /** Null for every folder; otherwise the folder and its subfolders. */
  folderId: number | null;
}

export interface ReportTargets {
  executedPct: number;
  passRatePct: number;
  /** Open defects older than this many days are outside the ageing SLA. */
  agingDays: number;
}

export interface ReportOptions {
  title: string;
  /** Cycle or environment shown in the header, e.g. "SIT Cycle 2". */
  environment: string;
  preparedBy: string;
  /** yyyy-mm-dd */
  goLive: string | null;
  baseline: ReportScope;
  scoped: ReportScope;
  targets: ReportTargets;
  status: "auto" | RagStatus;
  notes: string;
}

export function defaultReportOptions(): ReportOptions {
  return {
    title: "",
    environment: "",
    preparedBy: "",
    goLive: null,
    baseline: { releaseId: null, folderId: null },
    scoped: { releaseId: null, folderId: null },
    targets: { executedPct: 100, passRatePct: 95, agingDays: 10 },
    status: "auto",
    notes: "",
  };
}

export function emptyCounts(): OutcomeCounts {
  return { passed: 0, failed: 0, blocked: 0, caution: 0, notRun: 0, notApplicable: 0 };
}

export function outcomeOf(statusId: number | null): Outcome {
  switch (statusId) {
    case EXECUTION_STATUS.passed:
      return "passed";
    case EXECUTION_STATUS.failed:
      return "failed";
    case EXECUTION_STATUS.blocked:
      return "blocked";
    case EXECUTION_STATUS.caution:
      return "caution";
    case EXECUTION_STATUS.notApplicable:
      return "notApplicable";
    default:
      return "notRun";
  }
}

const EXECUTED: ReadonlySet<Outcome> = new Set(["passed", "failed", "blocked", "caution"]);
export const isExecuted = (o: Outcome) => EXECUTED.has(o);

/**
 * One result for a case planned on several platforms: a failure anywhere is a failure, then a block;
 * otherwise the case is not run until every platform has a result.
 */
export function combineOutcomes(outcomes: Outcome[]): Outcome {
  if (outcomes.length === 0) return "notRun";
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("blocked")) return "blocked";
  if (outcomes.includes("notRun")) return "notRun";
  if (outcomes.includes("caution")) return "caution";
  if (outcomes.every((o) => o === "notApplicable")) return "notApplicable";
  return "passed";
}

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

export function formatPct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}%`;
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const daysBetween = (fromIso: string, toIso: string) => Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);

/** A release and the sprints and iterations under it (the list is in hierarchy order). */
export function releaseFamily(releases: SpiraRelease[], releaseId: number): Set<number> {
  const ids = new Set([releaseId]);
  const i = releases.findIndex((r) => r.releaseId === releaseId);
  if (i < 0) return ids;
  for (let j = i + 1; j < releases.length && releases[j].depth > releases[i].depth; j += 1) ids.add(releases[j].releaseId);
  return ids;
}

/** A folder and every folder below it. */
export function folderFamily(folders: ReportFolder[], folderId: number): Set<number> {
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId !== null && ids.has(f.parentId) && !ids.has(f.folderId)) {
        ids.add(f.folderId);
        grew = true;
      }
    }
  }
  return ids;
}

/** Folder names from the root down to the folder. */
export function folderPath(folders: ReportFolder[], folderId: number | null): string[] {
  const byId = new Map(folders.map((f) => [f.folderId, f]));
  const path: string[] = [];
  const seen = new Set<number>();
  for (let f = folderId === null ? undefined : byId.get(folderId); f && !seen.has(f.folderId); f = f.parentId === null ? undefined : byId.get(f.parentId)) {
    seen.add(f.folderId);
    path.unshift(f.name);
  }
  return path;
}

export function setsInScope(catalog: Pick<ReportCatalog, "releases" | "folders" | "testSets">, scope: ReportScope): ReportTestSet[] {
  if (scope.releaseId === null) return [];
  const releases = releaseFamily(catalog.releases, scope.releaseId);
  const folders = scope.folderId === null ? null : folderFamily(catalog.folders, scope.folderId);
  return catalog.testSets.filter(
    (t) => t.releaseId !== null && releases.has(t.releaseId) && (folders === null || (t.folderId !== null && folders.has(t.folderId))),
  );
}

export function scopeLabel(catalog: Pick<ReportCatalog, "releases" | "folders">, scope: ReportScope): string {
  if (scope.releaseId === null) return "No release chosen";
  const release = catalog.releases.find((r) => r.releaseId === scope.releaseId);
  const name = release ? release.versionNumber || release.label : `Release ${scope.releaseId}`;
  return scope.folderId === null ? name : `${name} · ${folderPath(catalog.folders, scope.folderId).join(" / ")}`;
}

/** "1.0.0.0002" → "1.0.0.0001": the release a scoped release is usually compared with. */
export function previousVersion(version: string): string | null {
  const match = /^(.*?)(\d+)$/.exec(version.trim());
  if (!match || Number(match[2]) <= 1) return null;
  return match[1] + String(Number(match[2]) - 1).padStart(match[2].length, "0");
}

/** First-time setup: the working release from Settings in scope, compared with the release before it. */
export function initialReportOptions(releases: SpiraRelease[], releaseId: number | null): ReportOptions {
  const options = defaultReportOptions();
  const scoped = releases.find((r) => r.releaseId === releaseId);
  if (!scoped) return options;
  options.scoped.releaseId = scoped.releaseId;
  const previous = previousVersion(scoped.versionNumber);
  const baseline = previous ? releases.find((r) => r.versionNumber.trim() === previous) : undefined;
  if (baseline) options.baseline.releaseId = baseline.releaseId;
  return options;
}

export const sameScope = (a: ReportScope, b: ReportScope) => a.releaseId === b.releaseId && a.folderId === b.folderId;

const API_WORD = /\bapi\b/i;

/** Module identity across releases: "Notifications" and "Notification" are one module. */
export function moduleId(name: string): string {
  const key = moduleKey(name);
  return key.length > 3 ? key.replace(/s$/, "") : key;
}

/**
 * Module and platform of a test set: the module mapped in Settings wins; otherwise the name's platform
 * suffix ("Cards - Android"). Sets named API, or in a folder named API, are the API stream.
 */
export function classifySet(set: ReportTestSet, folders: ReportFolder[], mappings: TestSetMapping[]): { module: string; stream: Stream } {
  const mapped = mappings.find((m) => m.testSetId === set.testSetId);
  const api = API_WORD.test(set.name) || folderPath(folders, set.folderId).some((n) => API_WORD.test(n));
  const bare = set.name.replace(/\bapi\b/gi, " ").replace(/^[\s_\-–()]+|[\s_\-–()]+$/g, "").replace(/\s+/g, " ");
  const guess = guessMapping(bare || set.name);
  const name = mapped?.module ?? (bare ? guess.module : "API");
  if (api) return { module: name, stream: "API" };
  const platform = mapped && mapped.platform !== "Other" ? mapped.platform : guess.platform;
  return { module: name, stream: platform };
}

// ---------------------------------------------------------------------------------------------
// Defects

export type Level = "Critical" | "High" | "Medium" | "Low" | "Not set";
export const LEVELS: Level[] = ["Critical", "High", "Medium", "Low", "Not set"];

/** Reads Spira severity and priority names such as "1 - Critical" or "P2 High". */
export function levelOf(name: string | null): Level {
  if (!name?.trim()) return "Not set";
  if (/crit|blocker|urgent/i.test(name)) return "Critical";
  if (/high|major/i.test(name)) return "High";
  if (/med|moderate|normal/i.test(name)) return "Medium";
  if (/low|minor|trivial|cosmetic/i.test(name)) return "Low";
  const rank = /\d/.exec(name);
  return rank ? (["Critical", "High", "Medium", "Low"][Math.min(3, Math.max(0, Number(rank[0]) - 1))] as Level) : "Not set";
}

export type RetestState = "awaiting" | "retest" | "reopened" | "closed";

export const RETEST_LABEL: Record<RetestState, string> = {
  retest: "Fixed, ready for retest",
  closed: "Retested and closed",
  reopened: "Reopened after retest",
  awaiting: "Awaiting fix",
};

export function retestState(incident: ReportIncident): RetestState {
  if (!incident.open) return "closed";
  const status = incident.status ?? "";
  if (/reopen/i.test(status)) return "reopened";
  if (/resolv|fixed|ready (for )?(re)?test|retest|verif/i.test(status)) return "retest";
  return "awaiting";
}

export const AGE_BUCKETS = ["0–2 days", "3–5", "6–10", "> 10"] as const;
export function ageBucket(days: number): number {
  return days <= 2 ? 0 : days <= 5 ? 1 : days <= 10 ? 2 : 3;
}

export interface DefectRow {
  incident: ReportIncident;
  severity: Level;
  priority: Level;
  retest: RetestState;
  /** Days since it was raised, for open defects; null when closed or undated. */
  ageDays: number | null;
  modules: string[];
  testCaseIds: number[];
}

export interface DefectSummary {
  rows: DefectRow[];
  open: number;
  closed: number;
  /** Open defects by severity (rows) and age bucket (columns). */
  severityAge: Record<Level, number[]>;
  /** Open defects by priority. */
  byPriority: Record<Level, number>;
  retest: Record<RetestState, number>;
  openCriticalHigh: number;
  withinSla: number;
  /** Failed cases with no incident linked in Spira, among those looked up. */
  failedWithoutDefect: FailedCase[];
  /** Failed cases whose links were looked up. */
  failedChecked: number;
}

// ---------------------------------------------------------------------------------------------
// The report

export interface Kpis {
  baseline: number;
  inScope: number;
  executable: number;
  executed: number;
  outcomes: OutcomeCounts;
  execPct: number | null;
  passPct: number | null;
  added: number;
  deferred: number;
  coveragePct: number | null;
}

export interface StreamProgress {
  total: number;
  executed: number;
  outcomes: OutcomeCounts;
}

export interface ModuleRow {
  id: string;
  name: string;
  streams: Stream[];
  baseline: number;
  inScope: number;
  added: number;
  outcomes: OutcomeCounts;
  executable: number;
  executed: number;
  execPct: number | null;
  passPct: number | null;
  byStream: Partial<Record<Stream, StreamProgress>>;
  openDefects: number;
  defects: number;
  status: ModuleStatus;
  checks: { fullyRun: boolean; passOk: boolean | null; noBlocked: boolean };
  lastRun: string | null;
}

export interface StreamRow extends StreamProgress {
  stream: Stream;
  execPct: number | null;
  passPct: number | null;
}

export interface Criterion {
  label: string;
  target: string;
  actual: string;
  met: boolean;
  /** 0–1 for criteria shown as a bar, with the target marker. */
  progress: number | null;
  mark: number | null;
}

export interface ScopeRow {
  id: string;
  name: string;
  baseline: number;
  inScope: number;
  both: number;
  deferred: number;
  added: number;
  coveragePct: number | null;
  baselineStreams: Partial<Record<Stream, number>>;
  scopedStreams: Partial<Record<Stream, number>>;
}

export interface CaseRef {
  testCaseId: number;
  name: string;
  module: string;
}

export interface FailedCase extends CaseRef {
  streams: Stream[];
  incidentIds: number[];
  /** False when the case was beyond the link lookup limit. */
  checked: boolean;
}

export interface Finding {
  severity: "High" | "Medium" | "Low";
  check: string;
  appliesTo: string;
  detail: string;
}

export interface SetRow {
  set: ReportTestSet;
  module: string;
  stream: Stream;
  folder: string;
  /** Membership rows read from Spira; null when the set was not read. */
  read: number | null;
  spiraTotal: number;
  overdue: boolean;
}

export interface TrendDay {
  day: string;
  executed: number;
  failed: number;
  cumulative: number;
}

export interface ActionItem {
  title: string;
  detail: string;
  action: string;
}

export interface Narrative {
  headline: string;
  working: string[];
  risks: string[];
  actions: ActionItem[];
}

export interface Report {
  generatedAt: string;
  projectId: number;
  projectName: string;
  title: string;
  environment: string;
  preparedBy: string;
  hasBaseline: boolean;
  baselineLabel: string;
  scopedLabel: string;
  streams: Stream[];
  goLive: string | null;
  daysToGoLive: number | null;
  window: { first: string | null; last: string | null };
  kpis: Kpis;
  modules: ModuleRow[];
  streamRows: StreamRow[];
  readiness: Record<ModuleStatus, number>;
  criteria: Criterion[];
  status: RagStatus;
  autoStatus: RagStatus;
  statusReason: string;
  defects: DefectSummary;
  scope: { rows: ScopeRow[]; streams: Stream[]; added: CaseRef[]; deferred: CaseRef[] };
  findings: Finding[];
  narrative: Narrative;
  trend: { days: TrendDay[]; earlier: number; pacePerDay: number | null; daysToFinish: number | null };
  testSets: SetRow[];
  baselineSets: SetRow[];
  failedCases: FailedCase[];
  targets: ReportTargets;
  notes: string;
  sources: { incidentsComplete: boolean; linksPartial: boolean; setsRead: number; setsMissing: number };
}

export interface ReportInput {
  catalog: ReportCatalog;
  options: ReportOptions;
  mappings: TestSetMapping[];
  /** Cases per test set, as read from Spira. */
  results: Record<number, ReportCase[]>;
  incidents: ReportIncident[];
  incidentsComplete: boolean;
  /** Incidents linked to each looked-up test case. */
  links: Record<number, number[]>;
  generatedAt: string;
}

interface Placement {
  set: ReportTestSet;
  stream: Stream;
  outcome: Outcome;
  executionDate: string | null;
}

interface PlannedCase {
  testCaseId: number;
  name: string;
  moduleId: string;
  module: string;
  placements: Placement[];
}

interface Side {
  sets: Array<{ set: ReportTestSet; module: string; moduleId: string; stream: Stream }>;
  /** Keyed by module and test case: a case planned in two modules counts in both. */
  cases: Map<string, PlannedCase>;
  moduleNames: Map<string, string>;
}

function readSide(input: ReportInput, scope: ReportScope): Side {
  const sets = setsInScope(input.catalog, scope).map((set) => {
    const { module, stream } = classifySet(set, input.catalog.folders, input.mappings);
    return { set, module, moduleId: moduleId(module), stream };
  });
  const cases = new Map<string, PlannedCase>();
  const moduleNames = new Map<string, string>();
  for (const s of sets) {
    if (!moduleNames.has(s.moduleId)) moduleNames.set(s.moduleId, s.module);
    for (const c of input.results[s.set.testSetId] ?? []) {
      const key = `${s.moduleId}:${c.testCaseId}`;
      const planned = cases.get(key) ?? { testCaseId: c.testCaseId, name: c.name, moduleId: s.moduleId, module: s.module, placements: [] };
      planned.placements.push({ set: s.set, stream: s.stream, outcome: outcomeOf(c.statusId), executionDate: c.executionDate });
      cases.set(key, planned);
    }
  }
  return { sets, cases, moduleNames };
}

const caseOutcome = (c: PlannedCase) => combineOutcomes(c.placements.map((p) => p.outcome));

function lastRunOf(c: PlannedCase): string | null {
  let last: string | null = null;
  for (const p of c.placements) if (isExecuted(p.outcome) && p.executionDate && (!last || p.executionDate > last)) last = p.executionDate;
  return last;
}

function streamsOf(c: PlannedCase): Stream[] {
  return STREAMS.filter((s) => c.placements.some((p) => p.stream === s));
}

function byStream(cases: PlannedCase[]): Partial<Record<Stream, StreamProgress>> {
  const out: Partial<Record<Stream, StreamProgress>> = {};
  for (const c of cases) {
    for (const stream of streamsOf(c)) {
      const outcome = combineOutcomes(c.placements.filter((p) => p.stream === stream).map((p) => p.outcome));
      const row = (out[stream] ??= { total: 0, executed: 0, outcomes: emptyCounts() });
      row.total += 1;
      row.outcomes[outcome] += 1;
      if (isExecuted(outcome)) row.executed += 1;
    }
  }
  return out;
}

function tally(cases: PlannedCase[]): { outcomes: OutcomeCounts; executed: number; executable: number } {
  const outcomes = emptyCounts();
  for (const c of cases) outcomes[caseOutcome(c)] += 1;
  const executed = outcomes.passed + outcomes.failed + outcomes.blocked + outcomes.caution;
  return { outcomes, executed, executable: cases.length - outcomes.notApplicable };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export function buildReport(input: ReportInput): Report {
  const { catalog, options, generatedAt } = input;
  const targets = options.targets;
  const today = generatedAt;
  const baseline = readSide(input, options.baseline);
  const scoped = readSide(input, options.scoped);

  // Modules: scoped names win, then baseline names.
  const names = new Map([...baseline.moduleNames, ...scoped.moduleNames]);
  const scopedByModule = new Map<string, PlannedCase[]>();
  for (const c of scoped.cases.values()) scopedByModule.set(c.moduleId, [...(scopedByModule.get(c.moduleId) ?? []), c]);
  const baselineIds = new Map<string, Set<number>>();
  for (const c of baseline.cases.values()) baselineIds.set(c.moduleId, (baselineIds.get(c.moduleId) ?? new Set()).add(c.testCaseId));
  const scopedIds = new Map<string, Set<number>>();
  for (const c of scoped.cases.values()) scopedIds.set(c.moduleId, (scopedIds.get(c.moduleId) ?? new Set()).add(c.testCaseId));

  // Defects: raised against the scoped release, or linked to a scoped case.
  const scopedReleases = options.scoped.releaseId === null ? new Set<number>() : releaseFamily(catalog.releases, options.scoped.releaseId);
  const scopedCaseIds = new Set([...scoped.cases.values()].map((c) => c.testCaseId));
  const casesByIncident = new Map<number, Set<number>>();
  for (const [caseId, incidentIds] of Object.entries(input.links)) {
    if (!scopedCaseIds.has(Number(caseId))) continue;
    for (const incidentId of incidentIds) casesByIncident.set(incidentId, (casesByIncident.get(incidentId) ?? new Set()).add(Number(caseId)));
  }
  const modulesOfCase = new Map<number, Set<string>>();
  for (const c of scoped.cases.values()) modulesOfCase.set(c.testCaseId, (modulesOfCase.get(c.testCaseId) ?? new Set()).add(c.moduleId));

  const defectRows: DefectRow[] = input.incidents
    .filter((i) => (i.detectedReleaseId !== null && scopedReleases.has(i.detectedReleaseId)) || casesByIncident.has(i.incidentId))
    .map((incident) => {
      const caseIds = [...(casesByIncident.get(incident.incidentId) ?? [])].sort((a, b) => a - b);
      const moduleIds = new Set(caseIds.flatMap((id) => [...(modulesOfCase.get(id) ?? [])]));
      return {
        incident,
        severity: levelOf(incident.severity),
        priority: levelOf(incident.priority),
        retest: retestState(incident),
        ageDays: incident.open && incident.createdAt ? Math.max(0, daysBetween(incident.createdAt, today)) : null,
        modules: [...moduleIds].map((id) => names.get(id) ?? id).sort(),
        testCaseIds: caseIds,
      };
    })
    .sort(
      (a, b) =>
        Number(b.incident.open) - Number(a.incident.open) ||
        LEVELS.indexOf(a.severity) - LEVELS.indexOf(b.severity) ||
        LEVELS.indexOf(a.priority) - LEVELS.indexOf(b.priority) ||
        b.incident.incidentId - a.incident.incidentId,
    );

  const openDefectsByModule = new Map<string, number>();
  const defectsByModule = new Map<string, number>();
  for (const row of defectRows) {
    const moduleIdsOfRow = new Set(row.testCaseIds.flatMap((id) => [...(modulesOfCase.get(id) ?? [])]));
    for (const id of moduleIdsOfRow) {
      defectsByModule.set(id, (defectsByModule.get(id) ?? 0) + 1);
      if (row.incident.open) openDefectsByModule.set(id, (openDefectsByModule.get(id) ?? 0) + 1);
    }
  }

  // Module rows (in scope only).
  const modules: ModuleRow[] = [...scopedByModule.entries()].map(([id, cases]) => {
    const t = tally(cases);
    const inBaseline = baselineIds.get(id) ?? new Set<number>();
    const ids = scopedIds.get(id) ?? new Set<number>();
    const execPct = pct(t.executed, t.executable);
    const passPct = pct(t.outcomes.passed, t.executed);
    const openDefects = openDefectsByModule.get(id) ?? 0;
    const fullyRun = t.executable > 0 && t.executed === t.executable;
    const passOk = t.executed > 0 ? (passPct ?? 0) >= targets.passRatePct : null;
    const noBlocked = t.outcomes.blocked === 0;
    const status: ModuleStatus =
      t.executed === 0
        ? "notStarted"
        : fullyRun && passOk && noBlocked && openDefects === 0
          ? "ready"
          : t.outcomes.failed > 0 || !noBlocked || openDefects > 0 || passOk === false
            ? "atRisk"
            : "inProgress";
    let lastRun: string | null = null;
    for (const c of cases) {
      const run = lastRunOf(c);
      if (run && (!lastRun || run > lastRun)) lastRun = run;
    }
    return {
      id,
      name: names.get(id) ?? id,
      streams: STREAMS.filter((s) => cases.some((c) => c.placements.some((p) => p.stream === s))),
      baseline: inBaseline.size,
      inScope: cases.length,
      added: [...ids].filter((caseId) => !inBaseline.has(caseId)).length,
      ...t,
      execPct,
      passPct,
      byStream: byStream(cases),
      openDefects,
      defects: defectsByModule.get(id) ?? 0,
      status,
      checks: { fullyRun, passOk, noBlocked },
      lastRun,
    };
  });
  modules.sort((a, b) => (b.execPct ?? -1) - (a.execPct ?? -1) || b.inScope - a.inScope || a.name.localeCompare(b.name));

  const scopedCases = [...scoped.cases.values()];
  const total = tally(scopedCases);
  const allScopeIds = new Set([...scopedIds.keys(), ...baselineIds.keys()]);
  let both = 0;
  let deferred = 0;
  let added = 0;
  const scopeRows: ScopeRow[] = [...allScopeIds].map((id) => {
    const b = baselineIds.get(id) ?? new Set<number>();
    const s = scopedIds.get(id) ?? new Set<number>();
    const inBoth = [...s].filter((caseId) => b.has(caseId)).length;
    both += inBoth;
    deferred += b.size - inBoth;
    added += s.size - inBoth;
    const streamCounts = (side: Side) => {
      const out: Partial<Record<Stream, number>> = {};
      for (const c of side.cases.values()) if (c.moduleId === id) for (const stream of streamsOf(c)) out[stream] = (out[stream] ?? 0) + 1;
      return out;
    };
    return {
      id,
      name: names.get(id) ?? id,
      baseline: b.size,
      inScope: s.size,
      both: inBoth,
      deferred: b.size - inBoth,
      added: s.size - inBoth,
      coveragePct: pct(inBoth, b.size),
      baselineStreams: streamCounts(baseline),
      scopedStreams: streamCounts(scoped),
    };
  });
  scopeRows.sort((a, b) => b.inScope - a.inScope || b.baseline - a.baseline || a.name.localeCompare(b.name));
  const baselineTotal = [...baselineIds.values()].reduce((n, s) => n + s.size, 0);

  const kpis: Kpis = {
    baseline: baselineTotal,
    inScope: scopedCases.length,
    executable: total.executable,
    executed: total.executed,
    outcomes: total.outcomes,
    execPct: pct(total.executed, total.executable),
    passPct: pct(total.outcomes.passed, total.executed),
    added,
    deferred,
    coveragePct: pct(both, baselineTotal),
  };

  const streamTotals = byStream(scopedCases);
  const streamRows: StreamRow[] = STREAMS.filter((s) => streamTotals[s]).map((stream) => {
    const row = streamTotals[stream]!;
    return { stream, ...row, execPct: pct(row.executed, row.total - row.outcomes.notApplicable), passPct: pct(row.outcomes.passed, row.executed) };
  });

  const readiness: Record<ModuleStatus, number> = { ready: 0, atRisk: 0, inProgress: 0, notStarted: 0 };
  for (const m of modules) readiness[m.status] += 1;

  // Failed cases and their defects.
  const failedCases: FailedCase[] = scopedCases
    .filter((c) => caseOutcome(c) === "failed")
    .map((c) => ({
      testCaseId: c.testCaseId,
      name: c.name,
      module: c.module,
      streams: STREAMS.filter((s) => c.placements.some((p) => p.stream === s && p.outcome === "failed")),
      incidentIds: input.links[c.testCaseId] ?? [],
      checked: c.testCaseId in input.links,
    }))
    .sort((a, b) => a.module.localeCompare(b.module) || a.testCaseId - b.testCaseId);
  const failedChecked = failedCases.filter((c) => c.checked);

  const open = defectRows.filter((d) => d.incident.open);
  const severityAge = Object.fromEntries(LEVELS.map((l) => [l, [0, 0, 0, 0]])) as Record<Level, number[]>;
  const byPriority = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  const retest: Record<RetestState, number> = { awaiting: 0, retest: 0, reopened: 0, closed: 0 };
  for (const d of defectRows) retest[d.retest] += 1;
  for (const d of open) {
    severityAge[d.severity][ageBucket(d.ageDays ?? 0)] += 1;
    byPriority[d.priority] += 1;
  }
  const defects: DefectSummary = {
    rows: defectRows,
    open: open.length,
    closed: defectRows.length - open.length,
    severityAge,
    byPriority,
    retest,
    openCriticalHigh: open.filter((d) => d.severity === "Critical" || d.severity === "High").length,
    withinSla: open.filter((d) => (d.ageDays ?? 0) <= targets.agingDays).length,
    failedWithoutDefect: failedChecked.filter((c) => c.incidentIds.length === 0),
    failedChecked: failedChecked.length,
  };

  // Exit criteria.
  const levelCounts = (level: Level) => open.filter((d) => d.severity === level).length;
  const otherOpen = (["Medium", "Low", "Not set"] as Level[]).map((l) => [l, levelCounts(l)] as const).filter(([, n]) => n > 0);
  const modulesComplete = modules.filter((m) => m.checks.fullyRun).length;
  const criteria: Criterion[] = [
    {
      label: "Planned test cases executed",
      target: `${targets.executedPct}%`,
      actual: `${formatPct(kpis.execPct)} (${kpis.executed.toLocaleString()} of ${kpis.executable.toLocaleString()})`,
      met: (kpis.execPct ?? 0) >= targets.executedPct,
      progress: kpis.execPct === null ? 0 : kpis.execPct / 100,
      mark: targets.executedPct / 100,
    },
    {
      label: "Pass rate of executed tests",
      target: `≥ ${targets.passRatePct}%`,
      actual: formatPct(kpis.passPct),
      met: kpis.executed > 0 && (kpis.passPct ?? 0) >= targets.passRatePct,
      progress: kpis.passPct === null ? 0 : kpis.passPct / 100,
      mark: targets.passRatePct / 100,
    },
    {
      label: "Blocked test cases",
      target: "0",
      actual: kpis.outcomes.blocked.toLocaleString(),
      met: kpis.outcomes.blocked === 0,
      progress: null,
      mark: null,
    },
    {
      label: "Open Critical / High severity defects",
      target: "0",
      actual: `${defects.openCriticalHigh}${otherOpen.length ? ` (${otherOpen.map(([l, n]) => `${n} ${l === "Not set" ? "without severity" : l}`).join(", ")})` : ""}`,
      met: defects.openCriticalHigh === 0,
      progress: null,
      mark: null,
    },
    {
      label: "Defects retested and closed",
      target: "100%",
      actual: defectRows.length ? `${defects.closed} of ${defectRows.length} closed` : "No defects",
      met: defects.open === 0,
      progress: defectRows.length ? defects.closed / defectRows.length : 1,
      mark: 1,
    },
    {
      label: `Open defects within ageing SLA (≤ ${targets.agingDays} days)`,
      target: "100%",
      actual: defects.open ? `${defects.withinSla} of ${defects.open}` : "No open defects",
      met: defects.withinSla === defects.open,
      progress: defects.open ? defects.withinSla / defects.open : 1,
      mark: 1,
    },
    {
      label: "All modules executed on all platforms",
      target: `${modules.length} of ${modules.length}`,
      actual: `${modulesComplete} of ${modules.length} complete`,
      met: modules.length > 0 && modulesComplete === modules.length,
      progress: modules.length ? modulesComplete / modules.length : 0,
      mark: 1,
    },
  ];
  const metCount = criteria.filter((c) => c.met).length;

  const daysToGoLive = options.goLive ? daysBetween(dayOf(today), options.goLive) : null;
  const openCritical = levelCounts("Critical");
  const allMet = metCount === criteria.length;
  const autoStatus: RagStatus = allMet
    ? "green"
    : openCritical > 0 || (kpis.executed > 0 && (kpis.passPct ?? 0) < targets.passRatePct - 10) || (daysToGoLive !== null && daysToGoLive <= 3)
      ? "red"
      : "amber";
  const unmet = criteria.filter((c) => !c.met).map((c) => c.label.toLowerCase());
  const statusReason = allMet
    ? "Every exit criterion is met."
    : `${metCount} of ${criteria.length} exit criteria met; not yet met: ${list(unmet)}.`;

  // Trend: each scoped case on the day of its latest run.
  const runDays = new Map<string, { executed: number; failed: number }>();
  let first: string | null = null;
  let last: string | null = null;
  for (const c of scopedCases) {
    const run = lastRunOf(c);
    if (!run) continue;
    if (!first || run < first) first = run;
    if (!last || run > last) last = run;
    const day = runDays.get(dayOf(run)) ?? { executed: 0, failed: 0 };
    day.executed += 1;
    if (caseOutcome(c) === "failed") day.failed += 1;
    runDays.set(dayOf(run), day);
  }
  const TREND_DAYS = 21;
  const end = dayOf(today);
  const start = new Date(Date.parse(end) - (TREND_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  let earlier = 0;
  for (const [day, v] of runDays) if (day < start) earlier += v.executed;
  let cumulative = earlier;
  const trendDays: TrendDay[] = [];
  for (let i = 0; i < TREND_DAYS; i += 1) {
    const day = new Date(Date.parse(start) + i * DAY_MS).toISOString().slice(0, 10);
    const v = runDays.get(day) ?? { executed: 0, failed: 0 };
    cumulative += v.executed;
    trendDays.push({ day, executed: v.executed, failed: v.failed, cumulative });
  }
  const recent = trendDays.slice(-7).filter((d) => d.executed > 0);
  const pacePerDay = recent.length ? recent.reduce((n, d) => n + d.executed, 0) / recent.length : null;
  const remaining = kpis.executable - kpis.executed;
  const daysToFinish = pacePerDay && remaining > 0 ? Math.ceil(remaining / pacePerDay) : remaining > 0 ? null : 0;

  // Test sets.
  const folderName = (set: ReportTestSet) => folderPath(catalog.folders, set.folderId).join(" / ") || "Root";
  const toRow = (s: Side["sets"][number]): SetRow => {
    const read = input.results[s.set.testSetId];
    const spiraTotal = Object.values(s.set.counts).reduce((n, v) => n + v, 0);
    return {
      set: s.set,
      module: s.module,
      stream: s.stream,
      folder: folderName(s.set),
      read: read ? read.length : null,
      spiraTotal,
      overdue: !!s.set.plannedDate && dayOf(s.set.plannedDate) < end && s.set.counts.notRun > 0,
    };
  };
  const testSets = scoped.sets.map(toRow).sort((a, b) => a.module.localeCompare(b.module) || a.set.name.localeCompare(b.set.name));
  const baselineSets = baseline.sets.map(toRow).sort((a, b) => a.module.localeCompare(b.module) || a.set.name.localeCompare(b.set.name));
  const setsMissing = [...scoped.sets, ...baseline.sets].filter((s) => !input.results[s.set.testSetId]).length;

  // Data checks.
  const findings: Finding[] = [];
  const modulesOf = (cases: CaseRef[]) => list([...new Set(cases.map((c) => c.module))].sort());
  if (defects.failedWithoutDefect.length) {
    findings.push({
      severity: "High",
      check: "Failed results with no linked defect",
      appliesTo: modulesOf(defects.failedWithoutDefect),
      detail: `${defects.failedWithoutDefect.length} of ${defects.failedChecked} failed cases have no defect in Spira`,
    });
  }
  const mismatched = testSets.filter((r) => r.read !== null && r.read !== r.spiraTotal);
  if (mismatched.length) {
    findings.push({
      severity: "High",
      check: "Test set counts differ from its cases",
      appliesTo: list(mismatched.slice(0, 3).map((r) => r.set.name)) + (mismatched.length > 3 ? ` and ${mismatched.length - 3} more` : ""),
      detail: "Spira's counts and the cases read do not agree; results may have changed while reading. Refresh the report",
    });
  }
  if (defects.open && openCritical) {
    findings.push({ severity: "High", check: "Open Critical defects", appliesTo: list(defectRows.filter((d) => d.incident.open && d.severity === "Critical").slice(0, 4).map((d) => `IN:${d.incident.incidentId}`)), detail: `${openCritical} open` });
  }
  const unrated = defectRows.filter((d) => d.incident.open && (d.severity === "Not set" || d.priority === "Not set"));
  if (unrated.length) {
    findings.push({ severity: "Medium", check: "Severity or priority not set", appliesTo: "Open defects", detail: `${unrated.length} of ${defects.open} open defects` });
  }
  const notStarted = modules.filter((m) => m.status === "notStarted");
  if (notStarted.length) {
    findings.push({
      severity: "Medium",
      check: "Modules not started",
      appliesTo: list(notStarted.map((m) => m.name)),
      detail: `${plural(notStarted.reduce((n, m) => n + m.inScope, 0), "planned case")}`,
    });
  }
  const overdue = testSets.filter((r) => r.overdue);
  if (overdue.length) {
    findings.push({
      severity: "Medium",
      check: "Test sets past their planned date",
      appliesTo: list(overdue.slice(0, 3).map((r) => r.set.name)) + (overdue.length > 3 ? ` and ${overdue.length - 3} more` : ""),
      detail: `${plural(overdue.length, "test set")} with cases still to run`,
    });
  }
  const differing = scopedCases.filter((c) => {
    const results = new Set(c.placements.filter((p) => isExecuted(p.outcome)).map((p) => (p.outcome === "caution" ? "passed" : p.outcome)));
    return results.size > 1;
  });
  if (differing.length) {
    findings.push({ severity: "Medium", check: "Results differ between platforms", appliesTo: modulesOf(differing), detail: `${plural(differing.length, "case")} passed on one platform and not on another` });
  }
  const bothMobile = new Set(modules.filter((m) => m.streams.includes("iOS") && m.streams.includes("Android")).map((m) => m.id));
  const gaps = scopedCases.filter((c) => {
    if (!bothMobile.has(c.moduleId)) return false;
    const own = new Set(c.placements.map((p) => p.stream));
    return own.has("iOS") !== own.has("Android");
  });
  if (gaps.length) {
    findings.push({ severity: "Medium", check: "Cases on one mobile platform only", appliesTo: modulesOf(gaps), detail: `${plural(gaps.length, "case")} in the iOS or the Android sets but not both` });
  }
  const addedCases: CaseRef[] = [];
  const deferredCases: CaseRef[] = [];
  for (const c of scoped.cases.values()) if (!baselineIds.get(c.moduleId)?.has(c.testCaseId)) addedCases.push({ testCaseId: c.testCaseId, name: c.name, module: c.module });
  for (const c of baseline.cases.values()) if (!scopedIds.get(c.moduleId)?.has(c.testCaseId)) deferredCases.push({ testCaseId: c.testCaseId, name: c.name, module: names.get(c.moduleId) ?? c.module });
  addedCases.sort((a, b) => a.module.localeCompare(b.module) || a.testCaseId - b.testCaseId);
  deferredCases.sort((a, b) => a.module.localeCompare(b.module) || a.testCaseId - b.testCaseId);
  if (options.baseline.releaseId !== null && addedCases.length) {
    findings.push({ severity: "Low", check: "Cases in scope but not in the baseline", appliesTo: modulesOf(addedCases), detail: `${plural(addedCases.length, "case")}, for example written during testing` });
  }
  if (!input.incidentsComplete) {
    findings.push({ severity: "Low", check: "Incident list may be incomplete", appliesTo: "Defects", detail: "Spira returned only its most recent incidents; linked defects are still included" });
  }
  const linksPartial = failedCases.some((c) => !c.checked);
  if (linksPartial) {
    findings.push({ severity: "Low", check: "Defect links checked for some failures only", appliesTo: "Failed cases", detail: `${failedChecked.length} of ${failedCases.length} failed cases were checked` });
  }

  // Narrative.
  const scopeName = options.environment.trim() || scopeLabel(catalog, options.scoped);
  const failingModules = modules.filter((m) => m.outcomes.failed > 0).sort((a, b) => b.outcomes.failed - a.outcomes.failed);
  const ready = modules.filter((m) => m.status === "ready");
  const notStartedCases = notStarted.reduce((n, m) => n + m.inScope, 0);
  const headlineParts = [
    `In ${scopeName}, ${kpis.executed.toLocaleString()} of ${plural(kpis.executable, "in-scope test case")} ${kpis.executed === 1 ? "has" : "have"} been executed (${formatPct(kpis.execPct)})${kpis.executed ? ` and ${formatPct(kpis.passPct)} passed` : ""}.`,
    `${ready.length} of ${plural(modules.length, "module")} ${ready.length === 1 ? "is" : "are"} ready for UAT.`,
  ];
  if (failingModules.length) {
    const top = failingModules[0];
    headlineParts.push(
      failingModules.length === 1
        ? kpis.outcomes.failed === 1
          ? `The only failure is in ${top.name}.`
          : `All ${plural(kpis.outcomes.failed, "failure")} sit in ${top.name}.`
        : `${plural(kpis.outcomes.failed, "failure")} across ${list(failingModules.map((m) => m.name))}; ${top.name} has the most (${top.outcomes.failed}).`,
    );
  }
  if (notStarted.length) headlineParts.push(`${list(notStarted.map((m) => m.name))} (${plural(notStartedCases, "case")}) ${notStarted.length === 1 ? "has" : "have"} not started.`);

  const working: string[] = [];
  if (ready.length) working.push(`${list(ready.map((m) => m.name))} passed all ${ready.reduce((n, m) => n + m.executed, 0).toLocaleString()} cases they ran, with no open defects.`);
  if (kpis.executed) working.push(`Overall pass rate is ${formatPct(kpis.passPct)} across ${plural(kpis.executed, "executed case")}.`);
  const multi = streamRows.filter((s) => s.total > 0);
  if (multi.length > 1) working.push(`Progress by platform: ${multi.map((s) => `${s.stream} ${formatPct(s.execPct, 0)} run`).join(", ")}.`);
  if (options.baseline.releaseId !== null && kpis.coveragePct !== null) working.push(`${formatPct(kpis.coveragePct)} of the baseline (${scopeLabel(catalog, options.baseline)}) is in scope.`);

  const risks: string[] = [];
  const actions: ActionItem[] = [];
  for (const m of failingModules.slice(0, 3)) {
    risks.push(`${m.name} passed ${m.outcomes.passed} of ${m.executed} cases (${formatPct(m.passPct)}), with ${plural(m.outcomes.failed, "failure")} and ${plural(m.openDefects, "open defect")}.`);
    actions.push({
      title: `${m.name} quality`,
      detail: `${m.outcomes.passed} of ${m.executed} ${m.name} cases passed (${formatPct(m.passPct)}); ${plural(m.outcomes.failed, "case")} failed and ${plural(m.openDefects, "defect")} ${m.openDefects === 1 ? "is" : "are"} open.`,
      action: `Fix and retest the open defects, then regress ${m.name}.`,
    });
  }
  if (defects.openCriticalHigh) {
    risks.push(`${plural(defects.openCriticalHigh, "Critical or High severity defect")} ${defects.openCriticalHigh === 1 ? "is" : "are"} open.`);
    actions.unshift({
      title: "Critical and High defects",
      detail: `${plural(defects.openCriticalHigh, "open defect")} of Critical or High severity block sign-off.`,
      action: "Fix and retest these first; they decide the exit.",
    });
  }
  if (remaining > 0) {
    const pace = pacePerDay ? ` At the recent pace (about ${Math.round(pacePerDay)} cases a day) that is about ${plural(daysToFinish ?? 0, "day")} of execution.` : "";
    const goLive = daysToGoLive !== null ? ` Go-live is ${daysToGoLive >= 0 ? `in ${plural(daysToGoLive, "day")}` : `${plural(-daysToGoLive, "day")} past`}.` : "";
    if (notStarted.length) risks.push(`${list(notStarted.map((m) => m.name))} (${plural(notStartedCases, "case")}) ${notStarted.length === 1 ? "has" : "have"} not started.`);
    actions.push({
      title: "Remaining scope",
      detail: `${plural(remaining, "in-scope case")} still to run${notStarted.length ? `, including ${list(notStarted.map((m) => m.name))} (${notStartedCases.toLocaleString()} not started)` : ""}.${pace}`,
      action: `Schedule the next execution window.${goLive}`,
    });
  }
  if (defects.failedWithoutDefect.length || unrated.length) {
    const parts = [
      defects.failedWithoutDefect.length ? `${plural(defects.failedWithoutDefect.length, "failed result")} ${defects.failedWithoutDefect.length === 1 ? "has" : "have"} no linked defect` : "",
      unrated.length ? `${plural(unrated.length, "open defect")} ${unrated.length === 1 ? "has" : "have"} no severity or priority` : "",
    ].filter(Boolean);
    risks.push(`${parts.join("; ")}.`);
    actions.push({ title: "Reporting data", detail: `${parts.join("; ")}.`, action: "Link the failed results to defects and set severity and priority in Spira." });
  }
  if (overdue.length) {
    actions.push({
      title: "Overdue test sets",
      detail: `${plural(overdue.length, "test set")} ${overdue.length === 1 ? "is" : "are"} past ${overdue.length === 1 ? "its" : "their"} planned date with cases still to run.`,
      action: "Re-plan these sets or run them in the next window.",
    });
  }
  if (defects.retest.retest) {
    actions.push({ title: "Fixes awaiting retest", detail: `${plural(defects.retest.retest, "defect")} ${defects.retest.retest === 1 ? "is" : "are"} fixed and ready to retest.`, action: "Retest on the next build and close or reopen them." });
  }

  return {
    generatedAt,
    projectId: catalog.projectId,
    projectName: catalog.projectName,
    title: options.title.trim() || `${catalog.projectName} — Test Report`,
    environment: options.environment.trim(),
    preparedBy: options.preparedBy.trim(),
    hasBaseline: options.baseline.releaseId !== null,
    baselineLabel: scopeLabel(catalog, options.baseline),
    scopedLabel: scopeLabel(catalog, options.scoped),
    streams: STREAMS.filter((s) => streamTotals[s]),
    goLive: options.goLive,
    daysToGoLive,
    window: { first, last },
    kpis,
    modules,
    streamRows,
    readiness,
    criteria,
    status: options.status === "auto" ? autoStatus : options.status,
    autoStatus,
    statusReason,
    defects,
    scope: { rows: scopeRows, streams: STREAMS.filter((s) => scopeRows.some((r) => r.baselineStreams[s] || r.scopedStreams[s])), added: addedCases, deferred: deferredCases },
    findings,
    narrative: { headline: headlineParts.join(" "), working, risks, actions },
    trend: { days: trendDays, earlier, pacePerDay, daysToFinish },
    testSets,
    baselineSets,
    failedCases,
    targets,
    notes: options.notes.trim(),
    sources: { incidentsComplete: input.incidentsComplete, linksPartial, setsRead: Object.keys(input.results).length, setsMissing },
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshots, for "change since the last report"

export interface SnapshotModule {
  id: string;
  name: string;
  inScope: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
}

export interface ReportSnapshot {
  at: string;
  modules: SnapshotModule[];
  totals: { inScope: number; executed: number; passed: number; failed: number; openDefects: number };
}

export function snapshotOf(report: Report): ReportSnapshot {
  return {
    at: report.generatedAt,
    modules: report.modules.map((m) => ({
      id: m.id,
      name: m.name,
      inScope: m.inScope,
      executed: m.executed,
      passed: m.outcomes.passed,
      failed: m.outcomes.failed,
      blocked: m.outcomes.blocked,
    })),
    totals: {
      inScope: report.kpis.inScope,
      executed: report.kpis.executed,
      passed: report.kpis.outcomes.passed,
      failed: report.kpis.outcomes.failed,
      openDefects: report.defects.open,
    },
  };
}

/** The latest snapshot from an earlier day than the report. */
export function previousSnapshot(snapshots: ReportSnapshot[], report: Report): ReportSnapshot | null {
  const day = dayOf(report.generatedAt);
  return snapshots.filter((s) => dayOf(s.at) < day).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/** Keeps one snapshot per day (the latest), newest first, at most `keep`. */
export function addSnapshot(snapshots: ReportSnapshot[], snapshot: ReportSnapshot, keep = 60): ReportSnapshot[] {
  return [snapshot, ...snapshots.filter((s) => dayOf(s.at) !== dayOf(snapshot.at))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, keep);
}

export type Movement = "good" | "bad" | "neutral";

export interface ChangeRow {
  name: string;
  before: string;
  now: string;
  movement: string;
  tone: Movement;
}

const progressText = (m: SnapshotModule | undefined) =>
  !m ? "Not in scope" : m.executed === 0 ? `0 of ${m.inScope} run` : `${m.executed} of ${m.inScope} run · ${m.failed} failed`;

export function compareSnapshots(previous: ReportSnapshot, current: ReportSnapshot): ChangeRow[] {
  const before = new Map(previous.modules.map((m) => [m.id, m]));
  const now = new Map(current.modules.map((m) => [m.id, m]));
  const rows: ChangeRow[] = [];
  for (const m of current.modules) {
    const p = before.get(m.id);
    let movement: string;
    let tone: Movement;
    if (!p) [movement, tone] = ["New in scope", "neutral"];
    else if (m.failed > p.failed) [movement, tone] = [p.failed === 0 ? "New risk" : `${m.failed - p.failed} more failed`, "bad"];
    else if (p.failed > 0 && m.failed === 0) [movement, tone] = ["Failures cleared", "good"];
    else if (m.executed === m.inScope && p.executed < p.inScope && m.failed === 0) [movement, tone] = ["Fully executed", "good"];
    else if (m.failed < p.failed) [movement, tone] = [`${p.failed - m.failed} fewer failed`, "good"];
    else if (m.executed > p.executed) [movement, tone] = [`+${m.executed - p.executed} run`, "good"];
    else if (m.inScope !== p.inScope) [movement, tone] = [`Scope ${m.inScope > p.inScope ? "+" : ""}${m.inScope - p.inScope} cases`, "neutral"];
    else [movement, tone] = ["No change", "neutral"];
    rows.push({ name: m.name, before: progressText(p), now: progressText(m), movement, tone });
  }
  for (const p of previous.modules) if (!now.has(p.id)) rows.push({ name: p.name, before: progressText(p), now: "Not in scope", movement: "Removed from scope", tone: "neutral" });
  return rows;
}
