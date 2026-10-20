import { z } from "zod";
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

/** This build alone, this build against the total test plan, or the total test plan alone. */
export type ReportKind = "build" | "buildVsPlan" | "plan";
export const REPORT_KINDS: ReportKind[] = ["build", "buildVsPlan", "plan"];

export interface ReportOptions {
  kind: ReportKind;
  title: string;
  /** Cycle or environment shown in the header, e.g. "SIT Cycle 2". */
  environment: string;
  preparedBy: string;
  /** yyyy-mm-dd */
  goLive: string | null;
  /** The release holding the total test plan. */
  baseline: ReportScope;
  /** The release being tested. */
  scoped: ReportScope;
  targets: ReportTargets;
  status: "auto" | RagStatus;
  notes: string;
  /** Name of the build being tested, e.g. "Phase 1"; empty reads "this build". */
  phase: string;
  /** Name of the baseline in comparisons, e.g. "Cycle 1"; empty uses its folder or release. */
  baselineName: string;
  /** Replaces the execution window read from the run dates, e.g. "Fri 9 – Sun 11 Oct 2026". */
  windowText: string;
  /** Adds the data checks, trend, test sets and failed cases after the four report pages. */
  appendix: boolean;
  /** QA's reading of each defect, keyed by incident ID. */
  defectNotes: Record<string, DefectNote>;
  /** Review bucket (Defects page) whose members feed the All-time defects KPI. */
  defectBucketId: string | null;
  /** Display name of that bucket when the report was last generated. */
  defectBucketName: string;
  /** Incident IDs in the chosen Review bucket (snapshot for generate/share). */
  defectRegisterIds: number[];
}

export type DefectPhase = "in" | "out" | "tbc";

export interface DefectNote {
  feature: string;
  /** Empty: in the build when the defect is linked to a case in scope. */
  phase: DefectPhase | "";
  rationale: string;
}

export function defaultReportOptions(): ReportOptions {
  return {
    kind: "buildVsPlan",
    title: "",
    environment: "",
    preparedBy: "",
    goLive: null,
    baseline: { releaseId: null, folderId: null },
    scoped: { releaseId: null, folderId: null },
    targets: { executedPct: 100, passRatePct: 95, agingDays: 10 },
    status: "auto",
    notes: "",
    phase: "",
    baselineName: "",
    windowText: "",
    appendix: false,
    defectNotes: {},
    defectBucketId: null,
    defectBucketName: "",
    defectRegisterIds: [],
  };
}

const scopeSchema = z.object({ releaseId: z.number().int().positive().nullable(), folderId: z.number().int().positive().nullable() });
const text = (max: number) => z.string().max(max).catch("");
/** A report's setup as received from outside: text is capped and unknown values fall back. */
export const reportOptionsSchema = z.object({
  kind: z.enum(REPORT_KINDS).catch("buildVsPlan"),
  title: text(200),
  environment: text(120),
  preparedBy: text(120),
  goLive: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  baseline: scopeSchema,
  scoped: scopeSchema,
  targets: z.object({ executedPct: z.number().min(1).max(100), passRatePct: z.number().min(1).max(100), agingDays: z.number().int().min(1).max(365) }),
  status: z.enum(["auto", "green", "amber", "red"]).catch("auto"),
  notes: text(4000),
  phase: text(120),
  baselineName: text(120),
  windowText: text(120),
  appendix: z.boolean().catch(false),
  defectNotes: z
    .record(z.string().regex(/^\d+$/), z.object({ feature: text(200), phase: z.enum(["in", "out", "tbc", ""]).catch(""), rationale: text(500) }))
    .catch({}),
  defectBucketId: z.string().max(80).nullable().catch(null),
  defectBucketName: text(120),
  defectRegisterIds: z.array(z.number().int().positive()).max(5000).catch([]),
});
const shareSchema = z.object({ p: z.number().int().positive(), o: reportOptionsSchema });

/** The report's setup as URL-safe text, so a signed-in colleague can read the same report from Spira. */
export function encodeShare(projectId: number, options: ReportOptions): string {
  const o = reportOptionsSchema.parse(options);
  const bytes = new TextEncoder().encode(JSON.stringify({ p: projectId, o }));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null when the text is not a report link. */
export function decodeShare(value: string): { projectId: number; options: ReportOptions } | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const parsed = shareSchema.safeParse(JSON.parse(json));
    return parsed.success ? { projectId: parsed.data.p, options: { ...defaultReportOptions(), ...parsed.data.o } } : null;
  } catch {
    return null;
  }
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

export interface ScopeHint {
  scope: ReportScope;
  label: string;
  sets: number;
}

/**
 * When a scope finds no test sets: the releases the chosen folder's test sets are planned for, and the
 * top-level folders holding the chosen release's test sets, most first.
 */
export function scopeHints(catalog: Pick<ReportCatalog, "releases" | "folders" | "testSets">, scope: ReportScope): { byRelease: ScopeHint[]; byFolder: ScopeHint[] } {
  const releaseOf = new Map<number, number>();
  for (const r of catalog.releases) if (r.depth === 0) for (const id of releaseFamily(catalog.releases, r.releaseId)) releaseOf.set(id, r.releaseId);
  const inFolder = scope.folderId === null ? null : folderFamily(catalog.folders, scope.folderId);
  const releases = new Map<number | null, number>();
  for (const t of catalog.testSets) {
    if (inFolder && (t.folderId === null || !inFolder.has(t.folderId))) continue;
    const top = t.releaseId === null ? null : (releaseOf.get(t.releaseId) ?? t.releaseId);
    releases.set(top, (releases.get(top) ?? 0) + 1);
  }
  const byRelease = [...releases]
    .map(([releaseId, sets]) => ({
      scope: { releaseId, folderId: scope.folderId },
      label: releaseId === null ? "No release" : (catalog.releases.find((r) => r.releaseId === releaseId)?.label ?? `Release ${releaseId}`),
      sets,
    }))
    .sort((a, b) => b.sets - a.sets);

  const byFolder: ScopeHint[] = [];
  if (scope.releaseId !== null) {
    const family = releaseFamily(catalog.releases, scope.releaseId);
    const parentOf = new Map(catalog.folders.map((f) => [f.folderId, f.parentId]));
    const roots = new Map<number | null, number>();
    for (const t of catalog.testSets) {
      if (t.releaseId === null || !family.has(t.releaseId)) continue;
      let root = t.folderId;
      for (let depth = 0; root !== null && (parentOf.get(root) ?? null) !== null && depth < 50; depth += 1) root = parentOf.get(root) ?? null;
      roots.set(root, (roots.get(root) ?? 0) + 1);
    }
    for (const [folderId, sets] of roots) {
      byFolder.push({ scope: { releaseId: scope.releaseId, folderId }, label: folderId === null ? "No folder" : folderPath(catalog.folders, folderId).join(" / "), sets });
    }
    byFolder.sort((a, b) => b.sets - a.sets);
  }
  return { byRelease, byFolder };
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
/** Phase 1 is the working release; the total test plan is the plan release when it exists, else the release before Phase 1. */
export function initialReportOptions(releases: SpiraRelease[], releaseId: number | null, planReleaseId: number | null = null): ReportOptions {
  const options = defaultReportOptions();
  const scoped = releases.find((r) => r.releaseId === releaseId);
  if (!scoped) return options;
  options.scoped.releaseId = scoped.releaseId;
  const chosen = planReleaseId !== scoped.releaseId ? releases.find((r) => r.releaseId === planReleaseId) : undefined;
  const previous = previousVersion(scoped.versionNumber);
  const baseline = chosen ?? (previous ? releases.find((r) => r.versionNumber.trim() === previous) : undefined);
  if (baseline) options.baseline.releaseId = baseline.releaseId;
  return options;
}

export const sameScope = (a: ReportScope, b: ReportScope) => a.releaseId === b.releaseId && a.folderId === b.folderId;

/**
 * The scopes a report reads, from its kind: whole releases, every folder. The total test plan alone is
 * reported as the build, under its own cycle name.
 */
export function resolveReportOptions(options: ReportOptions): ReportOptions {
  const build = { releaseId: options.scoped.releaseId, folderId: null };
  const plan = { releaseId: options.baseline.releaseId, folderId: null };
  const none = { releaseId: null, folderId: null };
  if (options.kind === "build") return { ...options, scoped: build, baseline: none };
  if (options.kind === "plan") return { ...options, scoped: plan, baseline: none, environment: options.baselineName };
  return { ...options, scoped: build, baseline: plan };
}

const API_WORD = /\bapi\b/i;

/** "Project-Simba — Daily SIT Test Report 2026-10-12", safe as a file name. */
export const reportFileName = (report: Pick<Report, "title" | "generatedAt">) => `${report.title} ${report.generatedAt.slice(0, 10)}`.replace(/[\\/:*?"<>|]+/g, "-");

/** Module identity across releases: "Notifications" and "Notification" are one module. */
export function moduleId(name: string): string {
  return moduleKey(name);
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
  closed: "Retested: passed (closed)",
  reopened: "Retested: failed (reopened)",
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
  /** Failed runs in scope of the linked cases. */
  failedRuns: number;
  feature: string;
  /** In the build being tested, outside it, or awaiting confirmation; null when unknown. */
  phase: DefectPhase | null;
  rationale: string;
  /** True when linked only to the API stream (or an obvious API/HTTP failure with no platform link). */
  apiRelated: boolean;
}

const API_DEFECT_NAME = /\b(api|504|502|503|400\b|bad request|gateway timeout|endpoint)\b/i;

/** Platform register and 4d omit API-only defects; the open list at the end keeps every still-open bucket member. */
export function isApiRelatedDefect(testCaseIds: number[], streamsByCase: Map<number, ReadonlySet<Stream>>, name: string): boolean {
  const streams = new Set<Stream>();
  for (const id of testCaseIds) for (const s of streamsByCase.get(id) ?? []) streams.add(s);
  if (streams.size > 0) return [...streams].every((s) => s === "API");
  return API_DEFECT_NAME.test(name);
}

/** How an open Spira status name maps for the summary tile (To Do / In Dev / Open / other). */
export type OpenStatusBucket = "open" | "toDo" | "inDev" | "other";

export function openStatusBucket(status: string | null | undefined): OpenStatusBucket {
  const s = (status ?? "").trim();
  if (/^to[\s_-]*do$/i.test(s)) return "toDo";
  if (/^in[\s_-]*dev$/i.test(s)) return "inDev";
  if (/^open$/i.test(s)) return "open";
  return "other";
}

/** Spira "Done" stays off the executive report even when Spira still flags the incident open. */
export function isDoneStatus(status: string | null | undefined): boolean {
  return /^done$/i.test((status ?? "").trim());
}

export function countsOnDefectReport(incident: { open: boolean; status: string | null | undefined }): boolean {
  return incident.open && !isDoneStatus(incident.status);
}

export interface DefectSummary {
  rows: DefectRow[];
  /** Currently open defects in this build's register. */
  open: number;
  closed: number;
  /** Defects in the chosen Review bucket (all-time opened for this report). */
  everOpened: number;
  /** Bucket members that are still open (not closed) in Spira. */
  stillOpen: number;
  /** Still-open bucket members by Spira status family. */
  openStatus: Record<OpenStatusBucket, number>;
  /** Name of the Review bucket used for the all-time KPI, when set. */
  registerName: string | null;
  /** Review-bucket defects for 4d (Done and API-related omitted). */
  registerRows: DefectRow[];
  /** Still-open Review-bucket defects (for the list at the end of the report). */
  registerOpen: DefectRow[];
  /** Open defects by severity (rows) and age bucket (columns). */
  severityAge: Record<Level, number[]>;
  /** Open defects by priority, all and those in the build. */
  byPriority: Record<Level, number>;
  byPriorityInBuild: Record<Level, number>;
  retest: Record<RetestState, number>;
  openCriticalHigh: number;
  withinSla: number;
  /** Failed cases with no incident linked in Spira, among those looked up. */
  failedWithoutDefect: FailedCase[];
  /** Failed cases whose links were looked up. */
  failedChecked: number;
  /** One paragraph introducing the defects, from the figures. */
  summary: string;
}

// ---------------------------------------------------------------------------------------------
// The report
//
// Figures are test runs: a case counts once per platform it is planned on (iOS and Android are two
// runs), as in the daily SIT report. The API stream is not a platform run and is reported on its own.

export type PlatformSplit = Partial<Record<Stream, number>>;

export const isRunStream = (stream: Stream) => stream !== "API";

export interface Kpis {
  /** Runs in the baseline (the full plan); the runs in scope when there is no baseline. */
  plan: number;
  inScope: number;
  laterBuilds: number;
  executable: number;
  executed: number;
  stillToRun: number;
  outcomes: OutcomeCounts;
  planPct: number | null;
  execPct: number | null;
  passPct: number | null;
  /** Runs in scope that are not in the baseline (for example cases written during testing), and the reverse. */
  added: number;
  deferred: number;
  coveragePct: number | null;
  split: {
    plan: PlatformSplit;
    inScope: PlatformSplit;
    executed: PlatformSplit;
    passed: PlatformSplit;
    failed: PlatformSplit;
    stillToRun: PlatformSplit;
  };
  modulesInPlan: number;
  baseline: {
    outcomes: OutcomeCounts;
    executed: number;
    passPct: number | null;
  };
  api: {
    baseline: number;
    inScope: number;
    executed: number;
    passed: number;
    failed: number;
  };
  /** Spira's own counts summed over the platform test sets in scope. */
  spiraRollup: OutcomeCounts;
}

export interface StreamProgress {
  total: number;
  executed: number;
  outcomes: OutcomeCounts;
}

export interface ModuleRow {
  id: string;
  name: string;
  /** Platforms in scope (or in the baseline, for a module not in this build). */
  streams: Stream[];
  inBuild: boolean;
  plan: number;
  inScope: number;
  laterBuilds: number;
  added: number;
  outcomes: OutcomeCounts;
  executable: number;
  executed: number;
  stillToRun: number;
  execPct: number | null;
  passPct: number | null;
  byStream: Partial<Record<Stream, StreamProgress>>;
  baselineByStream: Partial<Record<Stream, StreamProgress>>;
  /** Distinct cases failed on at least one platform, and whether every case has the same result on each platform it ran on. */
  failedCases: number;
  samePerPlatform: boolean;
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
  /** How the criterion reads in a sentence, e.g. "pass rate". */
  short: string;
  target: string;
  actual: string;
  met: boolean;
}

export interface ReadinessBar {
  label: string;
  text: string;
  progress: number;
  mark: number;
  met: boolean;
  /** Paint the bar green even when the target is not met (pass rate is progress, not a failure). */
  soft?: boolean;
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
  /** Why each module has its UAT status, a sentence per group. */
  why: string[];
  actions: ActionItem[];
  scopeNote: string;
  dataNote: string;
}

export interface CycleComparison {
  /** The platform compared: iOS when it is in scope. */
  stream: Stream;
  baselineName: string;
  scopedName: string;
  rows: ChangeRow[];
}

export interface PhaseLabels {
  /** "This build (Phase 1)" */
  build: string;
  /** "Phase 1" or "this build" */
  name: string;
  /** "Phase 1" or "Build", for column headings */
  short: string;
  /** False when the build has no name, so phase-specific wording is left out. */
  named: boolean;
  inBuild: string;
  outside: string;
}

export interface Report {
  generatedAt: string;
  projectId: number;
  projectName: string;
  title: string;
  environment: string;
  preparedBy: string;
  kind: ReportKind;
  hasBaseline: boolean;
  baselineLabel: string;
  scopedLabel: string;
  baselineName: string;
  scopedName: string;
  labels: PhaseLabels;
  /** Platforms counted as runs, in scope. */
  streams: Stream[];
  goLive: string | null;
  daysToGoLive: number | null;
  window: { first: string | null; last: string | null; text: string | null };
  kpis: Kpis;
  modules: ModuleRow[];
  /** Modules in the baseline only: planned for a later build. */
  laterModules: ModuleRow[];
  streamRows: StreamRow[];
  readiness: Record<ModuleStatus, number>;
  criteria: Criterion[];
  bars: ReadinessBar[];
  status: RagStatus;
  autoStatus: RagStatus;
  statusReason: string;
  defects: DefectSummary;
  cycle: CycleComparison | null;
  scope: {
    rows: ScopeRow[];
    streams: Stream[];
    added: CaseRef[];
    deferred: CaseRef[];
  };
  findings: Finding[];
  narrative: Narrative;
  trend: {
    days: TrendDay[];
    earlier: number;
    pacePerDay: number | null;
    daysToFinish: number | null;
  };
  testSets: SetRow[];
  baselineSets: SetRow[];
  failedCases: FailedCase[];
  targets: ReportTargets;
  notes: string;
  appendix: boolean;
  sources: {
    incidentsComplete: boolean;
    linksPartial: boolean;
    setsRead: number;
    setsMissing: number;
  };
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
  sets: Array<{
    set: ReportTestSet;
    module: string;
    moduleId: string;
    stream: Stream;
  }>;
  /** Keyed by module and test case: a case planned in two modules counts in both. */
  cases: Map<string, PlannedCase>;
  moduleNames: Map<string, string>;
}

/** One planned run: a case on one platform of a module. */
interface Run {
  key: string;
  testCaseId: number;
  name: string;
  moduleId: string;
  module: string;
  stream: Stream;
  outcome: Outcome;
  lastRun: string | null;
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
      const planned = cases.get(key) ?? {
        testCaseId: c.testCaseId,
        name: c.name,
        moduleId: s.moduleId,
        module: s.module,
        placements: [],
      };
      planned.placements.push({
        set: s.set,
        stream: s.stream,
        outcome: outcomeOf(c.statusId),
        executionDate: c.executionDate,
      });
      cases.set(key, planned);
    }
  }
  return { sets, cases, moduleNames };
}

function streamsOf(c: PlannedCase): Stream[] {
  return STREAMS.filter((s) => c.placements.some((p) => p.stream === s));
}

/** Every planned run of a side; a case listed twice on one platform is one run, with its worst result. */
function runsOf(side: Side, streams: (stream: Stream) => boolean): Run[] {
  const runs: Run[] = [];
  for (const c of side.cases.values()) {
    for (const stream of streamsOf(c).filter(streams)) {
      const here = c.placements.filter((p) => p.stream === stream);
      let lastRun: string | null = null;
      for (const p of here) if (isExecuted(p.outcome) && p.executionDate && (!lastRun || p.executionDate > lastRun)) lastRun = p.executionDate;
      runs.push({
        key: `${c.moduleId}:${stream}:${c.testCaseId}`,
        testCaseId: c.testCaseId,
        name: c.name,
        moduleId: c.moduleId,
        module: c.module,
        stream,
        outcome: combineOutcomes(here.map((p) => p.outcome)),
        lastRun,
      });
    }
  }
  return runs;
}

function tally(runs: Run[]): StreamProgress & { executable: number } {
  const outcomes = emptyCounts();
  for (const r of runs) outcomes[r.outcome] += 1;
  const executed = outcomes.passed + outcomes.failed + outcomes.blocked + outcomes.caution;
  return {
    total: runs.length,
    outcomes,
    executed,
    executable: runs.length - outcomes.notApplicable,
  };
}

function byStream(runs: Run[]): Partial<Record<Stream, StreamProgress>> {
  const out: Partial<Record<Stream, StreamProgress>> = {};
  for (const stream of STREAMS) {
    const mine = runs.filter((r) => r.stream === stream);
    if (mine.length) {
      const { total, executed, outcomes } = tally(mine);
      out[stream] = { total, executed, outcomes };
    }
  }
  return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

function splitOf(runs: Run[], keep: (r: Run) => boolean = () => true): PlatformSplit {
  const out: PlatformSplit = {};
  for (const r of runs) if (keep(r)) out[r.stream] = (out[r.stream] ?? 0) + 1;
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const shortDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

export function phaseLabels(phase: string, kind: ReportKind = "buildVsPlan"): PhaseLabels {
  const name = phase.trim();
  if (kind === "plan") return { build: "Total test plan", name: "the total test plan", short: "Plan", named: false, inBuild: "In the plan", outside: "Outside the plan" };
  return name
    ? {
        build: `This build (${name})`,
        name,
        short: name,
        named: true,
        inBuild: `In ${name}`,
        outside: `Outside ${name}`,
      }
    : {
        build: "This build",
        name: "this build",
        short: "Build",
        named: false,
        inBuild: "In this build",
        outside: "Outside this build",
      };
}

/** "Fri 9 – Sun 11 Oct 2026" */
export function windowText(first: string, last: string): string {
  const a = new Date(first);
  const b = new Date(last);
  const opts = { timeZone: "UTC" } as const;
  const weekday = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", ...opts });
  const end = `${weekday(b)} ${b.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", ...opts })}`;
  if (dayOf(first) === dayOf(last)) return end;
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  const start = `${weekday(a)} ${a.toLocaleDateString("en-GB", { day: "numeric", ...(sameMonth ? {} : { month: "short" }), ...opts })}`;
  return `${start} – ${end}`;
}

/** "iOS 592 · Android 592" */
export function splitText(split: PlatformSplit, streams: Stream[]): string {
  return streams.map((s) => `${s} ${(split[s] ?? 0).toLocaleString()}`).join(" · ");
}

/** "592 per platform" when every platform has the same count, otherwise each platform's count. */
function perPlatform(split: PlatformSplit, streams: Stream[], unit = "per platform"): string {
  const values = streams.map((s) => split[s] ?? 0);
  if (streams.length > 1 && values.every((v) => v === values[0])) return `${values[0].toLocaleString()} ${unit}`;
  return splitText(split, streams);
}

/** "109 cases per platform (218 runs)", or "2 cases on iOS" when only one platform has any. */
function runsText(split: PlatformSplit, unit = "cases per platform"): string {
  const present = STREAMS.filter((s) => (split[s] ?? 0) > 0);
  const total = present.reduce((n, s) => n + (split[s] ?? 0), 0);
  if (present.length > 1) return `${perPlatform(split, present, unit)} (${plural(total, "run")})`;
  return present.length ? `${plural(total, "case")} on ${present[0]}` : "no cases";
}

/** The scope's cycle: its folder, or the deepest folder holding all its test sets ("SIT Cycle 2"); else the release. */
export function scopeName(catalog: Pick<ReportCatalog, "releases" | "folders" | "testSets">, scope: ReportScope): string {
  let path: string[] = [];
  if (scope.folderId !== null) path = folderPath(catalog.folders, scope.folderId);
  else {
    const paths = setsInScope(catalog, scope).map((s) => folderPath(catalog.folders, s.folderId));
    path = paths[0] ?? [];
    for (const other of paths.slice(1)) {
      let i = 0;
      while (i < path.length && path[i] === other[i]) i += 1;
      path = path.slice(0, i);
    }
  }
  return path.length ? path[path.length - 1] : scopeLabel(catalog, scope);
}

export function buildReport(input: ReportInput): Report {
  const { catalog, options, generatedAt } = input;
  const targets = options.targets;
  const today = generatedAt;
  const labels = phaseLabels(options.phase ?? "", options.kind);
  const notesById = options.defectNotes ?? {};
  const baseline = readSide(input, options.baseline);
  // This build is every case in the release's test sets, once per platform whose test sets hold it.
  const scoped = readSide(input, options.scoped);
  const hasBaseline = options.baseline.releaseId !== null;
  const names = new Map([...baseline.moduleNames, ...scoped.moduleNames]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const baselineName = options.baselineName?.trim() || (hasBaseline ? scopeName(catalog, options.baseline) : "the baseline");
  const scopedName = options.environment.trim() || scopeName(catalog, options.scoped);

  const runs = runsOf(scoped, isRunStream);
  const baseRuns = hasBaseline ? runsOf(baseline, isRunStream) : [];
  const baseKeys = new Set(baseRuns.map((r) => r.key));
  const runKeys = new Set(runs.map((r) => r.key));
  const runsByModule = groupBy(runs, (r) => r.moduleId);
  const baseByModule = groupBy(baseRuns, (r) => r.moduleId);
  const streams = STREAMS.filter((s) => runs.some((r) => r.stream === s));
  const baseStreams = STREAMS.filter((s) => baseRuns.some((r) => r.stream === s));

  // Defects: raised against the scoped release, or linked to a scoped case.
  const scopedReleases = options.scoped.releaseId === null ? new Set<number>() : releaseFamily(catalog.releases, options.scoped.releaseId);
  const scopedCaseIds = new Set([...scoped.cases.values()].map((c) => c.testCaseId));
  const casesByIncident = new Map<number, Set<number>>();
  for (const [caseId, incidentIds] of Object.entries(input.links)) {
    if (!scopedCaseIds.has(Number(caseId))) continue;
    for (const incidentId of incidentIds) casesByIncident.set(incidentId, (casesByIncident.get(incidentId) ?? new Set()).add(Number(caseId)));
  }
  const modulesOfCase = new Map<number, Set<string>>();
  const streamsByCase = new Map<number, Set<Stream>>();
  for (const c of scoped.cases.values()) {
    modulesOfCase.set(c.testCaseId, (modulesOfCase.get(c.testCaseId) ?? new Set()).add(c.moduleId));
    const streams = streamsByCase.get(c.testCaseId) ?? new Set<Stream>();
    for (const p of c.placements) streams.add(p.stream);
    streamsByCase.set(c.testCaseId, streams);
  }
  const failedRunsOfCase = new Map<number, number>();
  for (const r of runs) if (r.outcome === "failed") failedRunsOfCase.set(r.testCaseId, (failedRunsOfCase.get(r.testCaseId) ?? 0) + 1);

  const rowFor = (incident: (typeof input.incidents)[number]): DefectRow => {
    const caseIds = [...(casesByIncident.get(incident.incidentId) ?? [])].sort((a, b) => a - b);
    const moduleNames = [...new Set(caseIds.flatMap((id) => [...(modulesOfCase.get(id) ?? [])]))].map(nameOf).sort();
    const note = notesById[String(incident.incidentId)];
    return {
      incident,
      severity: levelOf(incident.severity),
      priority: levelOf(incident.priority),
      retest: retestState(incident),
      ageDays: incident.open && incident.createdAt ? Math.max(0, daysBetween(incident.createdAt, today)) : null,
      modules: moduleNames,
      testCaseIds: caseIds,
      failedRuns: caseIds.reduce((n, id) => n + (failedRunsOfCase.get(id) ?? 0), 0),
      feature: note?.feature.trim() || moduleNames.join(", "),
      phase: note?.phase || (caseIds.length ? "in" : null),
      rationale: note?.rationale.trim() ?? "",
      apiRelated: isApiRelatedDefect(caseIds, streamsByCase, incident.name),
    };
  };

  const defectRows: DefectRow[] = input.incidents
    .filter(
      (i) =>
        !isDoneStatus(i.status) &&
        ((i.detectedReleaseId !== null && scopedReleases.has(i.detectedReleaseId)) || casesByIncident.has(i.incidentId)),
    )
    .map(rowFor)
    .sort(
      (a, b) =>
        Number(b.incident.open) - Number(a.incident.open) ||
        LEVELS.indexOf(a.severity) - LEVELS.indexOf(b.severity) ||
        LEVELS.indexOf(a.priority) - LEVELS.indexOf(b.priority) ||
        b.incident.incidentId - a.incident.incidentId,
    );

  const openDefectsByModule = new Map<string, number>();
  const openInBuildByModule = new Map<string, number>();
  const defectsByModule = new Map<string, number>();
  for (const row of defectRows) {
    for (const id of new Set(row.testCaseIds.flatMap((caseId) => [...(modulesOfCase.get(caseId) ?? [])]))) {
      defectsByModule.set(id, (defectsByModule.get(id) ?? 0) + 1);
      if (countsOnDefectReport(row.incident)) {
        openDefectsByModule.set(id, (openDefectsByModule.get(id) ?? 0) + 1);
        // Out-of-scope notes do not block module readiness; they are tracked as scope drift instead.
        if (row.phase !== "out") openInBuildByModule.set(id, (openInBuildByModule.get(id) ?? 0) + 1);
      }
    }
  }

  const moduleRow = (id: string, mine: Run[], base: Run[], inBuild: boolean): ModuleRow => {
    const t = tally(mine);
    const plan = hasBaseline ? base.length : mine.length;
    const execPct = pct(t.executed, t.executable);
    const passPct = pct(t.outcomes.passed, t.executed);
    const openDefects = openDefectsByModule.get(id) ?? 0;
    const openInBuild = openInBuildByModule.get(id) ?? 0;
    const fullyRun = t.executable > 0 && t.executed === t.executable;
    const passOk = t.executed > 0 ? (passPct ?? 0) >= targets.passRatePct : null;
    const noBlocked = t.outcomes.blocked === 0;
    // Ready = fully executed (matches "modules fully executed" on the exit bars). Quality issues
    // stay visible on the module table; unfinished modules with blocks or in-scope open defects
    // are At risk, otherwise In progress.
    const status: ModuleStatus =
      t.executed === 0 ? "notStarted" : fullyRun ? "ready" : !noBlocked || openInBuild > 0 ? "atRisk" : "inProgress";
    const byCase = groupBy(mine, (r) => String(r.testCaseId));
    const samePerPlatform = [...byCase.values()].every((list) => new Set(list.filter((r) => isExecuted(r.outcome)).map((r) => r.outcome)).size <= 1);
    let lastRun: string | null = null;
    for (const r of mine) if (r.lastRun && (!lastRun || r.lastRun > lastRun)) lastRun = r.lastRun;
    return {
      id,
      name: nameOf(id),
      streams: STREAMS.filter((s) => (inBuild ? mine : base).some((r) => r.stream === s)),
      inBuild,
      plan,
      inScope: mine.length,
      laterBuilds: Math.max(0, plan - mine.length),
      added: hasBaseline ? mine.filter((r) => !baseKeys.has(r.key)).length : 0,
      outcomes: t.outcomes,
      executable: t.executable,
      executed: t.executed,
      stillToRun: t.executable - t.executed,
      execPct,
      passPct,
      byStream: byStream(mine),
      baselineByStream: byStream(base),
      failedCases: new Set(mine.filter((r) => r.outcome === "failed").map((r) => r.testCaseId)).size,
      samePerPlatform,
      openDefects,
      defects: defectsByModule.get(id) ?? 0,
      status,
      checks: { fullyRun, passOk, noBlocked },
      lastRun,
    };
  };

  const modules = [...runsByModule.keys()].map((id) => moduleRow(id, runsByModule.get(id)!, baseByModule.get(id) ?? [], true));
  modules.sort((a, b) => (b.execPct ?? -1) - (a.execPct ?? -1) || b.inScope - a.inScope || a.name.localeCompare(b.name));
  const laterModules = [...baseByModule.keys()]
    .filter((id) => !runsByModule.has(id))
    .map((id) => moduleRow(id, [], baseByModule.get(id)!, false))
    .sort((a, b) => b.plan - a.plan || a.name.localeCompare(b.name));

  const total = tally(runs);
  const baseTotal = tally(baseRuns);
  const plan = hasBaseline ? baseRuns.length : runs.length;
  const both = runs.filter((r) => baseKeys.has(r.key)).length;
  const apiRuns = runsOf(scoped, (s) => s === "API");
  const apiTotal = tally(apiRuns);
  const spiraRollup = emptyCounts();
  for (const s of scoped.sets) {
    if (!isRunStream(s.stream)) continue;
    spiraRollup.passed += s.set.counts.passed;
    spiraRollup.failed += s.set.counts.failed;
    spiraRollup.blocked += s.set.counts.blocked;
    spiraRollup.caution += s.set.counts.caution;
    spiraRollup.notRun += s.set.counts.notRun;
    spiraRollup.notApplicable += s.set.counts.notApplicable;
  }

  const kpis: Kpis = {
    plan,
    inScope: runs.length,
    laterBuilds: Math.max(0, plan - runs.length),
    executable: total.executable,
    executed: total.executed,
    stillToRun: total.executable - total.executed,
    outcomes: total.outcomes,
    planPct: pct(runs.length, plan),
    execPct: pct(total.executed, total.executable),
    passPct: pct(total.outcomes.passed, total.executed),
    added: hasBaseline ? runs.length - both : 0,
    deferred: hasBaseline ? baseRuns.length - both : 0,
    coveragePct: hasBaseline ? pct(both, baseRuns.length) : null,
    split: {
      plan: splitOf(hasBaseline ? baseRuns : runs),
      inScope: splitOf(runs),
      executed: splitOf(runs, (r) => isExecuted(r.outcome)),
      passed: splitOf(runs, (r) => r.outcome === "passed"),
      failed: splitOf(runs, (r) => r.outcome === "failed"),
      stillToRun: splitOf(runs, (r) => r.outcome === "notRun"),
    },
    modulesInPlan: modules.length + laterModules.length,
    baseline: {
      outcomes: baseTotal.outcomes,
      executed: baseTotal.executed,
      passPct: pct(baseTotal.outcomes.passed, baseTotal.executed),
    },
    api: {
      baseline: hasBaseline ? runsOf(baseline, (s) => s === "API").length : 0,
      inScope: apiRuns.length,
      executed: apiTotal.executed,
      passed: apiTotal.outcomes.passed,
      failed: apiTotal.outcomes.failed,
    },
    spiraRollup,
  };

  const byStreamTotals = byStream(runs);
  const streamRows: StreamRow[] = streams.map((stream) => {
    const row = byStreamTotals[stream]!;
    return {
      stream,
      ...row,
      execPct: pct(row.executed, row.total - row.outcomes.notApplicable),
      passPct: pct(row.outcomes.passed, row.executed),
    };
  });

  const readiness: Record<ModuleStatus, number> = {
    ready: 0,
    atRisk: 0,
    inProgress: 0,
    notStarted: 0,
  };
  for (const m of modules) readiness[m.status] += 1;

  // Failed cases (once per module) and their defects.
  const failedCases: FailedCase[] = [
    ...groupBy(
      runs.filter((r) => r.outcome === "failed"),
      (r) => `${r.moduleId}:${r.testCaseId}`,
    ).values(),
  ]
    .map((list) => ({
      testCaseId: list[0].testCaseId,
      name: list[0].name,
      module: list[0].module,
      streams: STREAMS.filter((s) => list.some((r) => r.stream === s)),
      incidentIds: input.links[list[0].testCaseId] ?? [],
      checked: list[0].testCaseId in input.links,
    }))
    .sort((a, b) => a.module.localeCompare(b.module) || a.testCaseId - b.testCaseId);
  const failedChecked = failedCases.filter((c) => c.checked);

  const open = defectRows.filter((d) => countsOnDefectReport(d.incident));
  const severityAge = Object.fromEntries(LEVELS.map((l) => [l, [0, 0, 0, 0]])) as Record<Level, number[]>;
  const byPriority = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  const byPriorityInBuild = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
  const retest: Record<RetestState, number> = {
    awaiting: 0,
    retest: 0,
    reopened: 0,
    closed: 0,
  };
  for (const d of defectRows) retest[d.retest] += 1;
  for (const d of open) {
    severityAge[d.severity][ageBucket(d.ageDays ?? 0)] += 1;
    byPriority[d.priority] += 1;
    if (d.phase === "in") byPriorityInBuild[d.priority] += 1;
  }
  const levelCounts = (level: Level) => open.filter((d) => d.severity === level).length;
  const openCriticalHigh = open.filter((d) => d.severity === "Critical" || d.severity === "High").length;
  const withinSla = open.filter((d) => (d.ageDays ?? 0) <= targets.agingDays).length;
  const failedWithoutDefect = failedChecked.filter((c) => c.incidentIds.length === 0);

  const registerIds = new Set(options.defectRegisterIds.filter((id) => id > 0));
  const registerIncidents = registerIds.size
    ? input.incidents.filter((i) => registerIds.has(i.incidentId) && !isDoneStatus(i.status))
    : [];
  const registerName = options.defectBucketName.trim() || null;
  const everOpened = registerIncidents.length;
  const registerStillOpen = registerIncidents.filter((i) => countsOnDefectReport(i));
  const openStatus: Record<OpenStatusBucket, number> = { open: 0, toDo: 0, inDev: 0, other: 0 };
  for (const i of registerStillOpen) openStatus[openStatusBucket(i.status)] += 1;
  const sortDefectRows = (list: DefectRow[]) =>
    [...list].sort(
      (a, b) =>
        Number(countsOnDefectReport(b.incident)) - Number(countsOnDefectReport(a.incident)) ||
        LEVELS.indexOf(a.severity) - LEVELS.indexOf(b.severity) ||
        LEVELS.indexOf(a.priority) - LEVELS.indexOf(b.priority) ||
        b.incident.incidentId - a.incident.incidentId,
    );
  const registerMapped = sortDefectRows(registerIncidents.map(rowFor));
  const registerRows = registerMapped.filter((r) => !r.apiRelated);
  const registerOpen = sortDefectRows(registerStillOpen.map(rowFor));

  const defectSummary = (() => {
    if (defectRows.length === 0) return `No defects are raised against ${scopedName} or linked to its cases.`;
    const ids = defectRows.map((d) => d.incident.incidentId).sort((a, b) => a - b);
    const defectModules = [...new Set(defectRows.flatMap((d) => d.modules))].sort();
    const raised = [...new Set(defectRows.flatMap((d) => (d.incident.createdAt ? [dayOf(d.incident.createdAt)] : [])))].sort();
    const failedLinked = new Set(defectRows.flatMap((d) => d.testCaseIds.filter((id) => failedRunsOfCase.has(id))));
    const failedRunsLinked = [...failedLinked].reduce((n, id) => n + (failedRunsOfCase.get(id) ?? 0), 0);
    const parts = [
      `${plural(defectRows.length, "defect")} logged in Spira (IN:${ids[0]}${ids.length > 1 ? ` – IN:${ids[ids.length - 1]}` : ""})`,
      defectModules.length === 1
        ? `${defectRows.length === 1 ? "in" : "all in"} ${defectModules[0]}`
        : defectModules.length
          ? `across ${list(defectModules)}`
          : "",
      raised.length === 1
        ? `raised on ${shortDay(raised[0])}`
        : raised.length > 1
          ? `raised ${shortDay(raised[0])} – ${shortDay(raised[raised.length - 1])}`
          : "",
    ].filter(Boolean);
    const covering = failedLinked.size
      ? `, covering ${plural(failedLinked.size, "failed case")} (${plural(failedRunsLinked, "failed run")}${streams.length > 1 ? ` across ${list(streams)}` : ""})`
      : "";
    const highPriority = byPriority.Critical + byPriority.High;
    const severity = openCriticalHigh
      ? `${plural(openCriticalHigh, "open defect")} ${openCriticalHigh === 1 ? "is" : "are"} Critical or High severity`
      : `None ${open.length === 1 ? "open " : ""}is Critical or High severity`;
    const priority = highPriority
      ? `; ${highPriority} ${highPriority === 1 ? "is" : "are"} Critical or High priority${byPriorityInBuild.Critical + byPriorityInBuild.High === highPriority && labels.named ? ` and in ${labels.name} journeys` : ""}`
      : "";
    return `${parts[0]}${parts.length > 1 ? `, ${parts.slice(1).join(" and ")}` : ""}${covering}. ${open.length} open, ${defectRows.length - open.length} closed. ${severity}${priority}.`;
  })();

  const defects: DefectSummary = {
    rows: defectRows,
    open: open.length,
    closed: defectRows.length - open.length,
    everOpened,
    stillOpen: registerStillOpen.length,
    openStatus,
    registerName,
    registerRows,
    registerOpen,
    severityAge,
    byPriority,
    byPriorityInBuild,
    retest,
    openCriticalHigh,
    withinSla,
    failedWithoutDefect,
    failedChecked: failedChecked.length,
    summary: defectSummary,
  };

  // Exit criteria.
  const otherOpen = (["Medium", "Low", "Not set"] as Level[]).map((l) => [l, levelCounts(l)] as const).filter(([, n]) => n > 0);
  const modulesComplete = modules.filter((m) => m.checks.fullyRun).length;
  const notStarted = modules.filter((m) => m.status === "notStarted");
  const raisedDays = [...new Set(open.flatMap((d) => (d.incident.createdAt ? [dayOf(d.incident.createdAt)] : [])))];
  const criteria: Criterion[] = [
    {
      label: "Planned test cases executed",
      short: "execution",
      target: `${targets.executedPct}%`,
      actual: `${formatPct(kpis.execPct)} (${kpis.executed.toLocaleString()} of ${kpis.executable.toLocaleString()})`,
      met: (kpis.execPct ?? 0) >= targets.executedPct,
    },
    {
      label: "Pass rate of executed tests",
      short: "pass rate",
      target: `≥ ${targets.passRatePct}%`,
      actual: formatPct(kpis.passPct),
      met: kpis.executed > 0 && (kpis.passPct ?? 0) >= targets.passRatePct,
    },
    {
      label: "Blocked test cases",
      short: "blocked tests",
      target: "0",
      actual: kpis.outcomes.blocked.toLocaleString(),
      met: kpis.outcomes.blocked === 0,
    },
    {
      label: "Open Critical / High severity defects",
      short: "no Critical or High severity defects",
      target: "0",
      actual: `${openCriticalHigh}${otherOpen.length ? ` (${otherOpen.map(([l, n]) => `${n} ${l === "Not set" ? "without severity" : l}`).join(", ")})` : ""}`,
      met: openCriticalHigh === 0,
    },
    {
      label: "Fixed defects retested and closed",
      short: "defect closure",
      target: "100%",
      actual: defectRows.length
        ? `${defects.closed} of ${defectRows.length} closed${open.length ? ` · ${retest.retest ? `${retest.retest} ready for retest` : "fixes pending"}` : ""}`
        : "No defects",
      met: open.length === 0,
    },
    {
      label: "Open defects within ageing SLA",
      short: "defect ageing",
      target: "100%",
      actual: open.length
        ? `${withinSla} of ${open.length}${raisedDays.length === 1 ? ` (${open.length === 1 ? "raised" : "all raised"} ${shortDay(raisedDays[0])})` : ` (≤ ${targets.agingDays} days)`}`
        : "No open defects",
      met: withinSla === open.length,
    },
    {
      label: "All modules executed on all platforms",
      short: "module coverage",
      target: `${modules.length} of ${modules.length}`,
      actual: `${modulesComplete} of ${modules.length} executed${notStarted.length ? ` · ${notStarted.length} not started` : ""}`,
      met: modules.length > 0 && modulesComplete === modules.length,
    },
  ];
  const bars: ReadinessBar[] = [
    {
      label: "Planned tests executed",
      text: `${formatPct(kpis.execPct)} vs ${targets.executedPct}%`,
      progress: (kpis.execPct ?? 0) / 100,
      mark: targets.executedPct / 100,
      met: criteria[0].met,
      soft: true,
    },
    {
      label: "Pass rate of executed",
      text: `${formatPct(kpis.passPct)} vs ≥${targets.passRatePct}%`,
      progress: (kpis.passPct ?? 0) / 100,
      mark: targets.passRatePct / 100,
      met: criteria[1].met,
      soft: true,
    },
    {
      label: "Modules fully executed",
      text: `${modulesComplete} of ${modules.length}`,
      progress: modules.length ? modulesComplete / modules.length : 0,
      mark: 1,
      met: criteria[6].met,
      soft: true,
    },
    {
      label: "Blocked tests cleared",
      text: `${kpis.outcomes.blocked.toLocaleString()} blocked`,
      progress: kpis.outcomes.blocked === 0 ? 1 : Math.max(0, 1 - kpis.outcomes.blocked / Math.max(1, kpis.executed)),
      mark: 1,
      met: criteria[2].met,
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
  const metNames = criteria.filter((c) => c.met).map((c) => c.short);
  const unmetNames = criteria.filter((c) => !c.met).map((c) => c.short);
  const countWord = (n: number) => ["None", "One", "Two", "Three", "Four", "Five", "Six", "Seven"][n] ?? String(n);
  const statusReason = allMet
    ? "Every exit criterion is met."
    : `${countWord(metCount)} of ${countWord(criteria.length).toLowerCase()} criteria ${metCount === 1 ? "is" : "are"} met${metNames.length ? ` (${list(metNames)})` : ""}; ${list(unmetNames)} ${unmetNames.length === 1 ? "is" : "are"} not yet met.`;

  // Execution window and trend, from each run's latest result.
  const runDays = new Map<string, { executed: number; failed: number }>();
  let first: string | null = null;
  let last: string | null = null;
  for (const r of runs) {
    if (!r.lastRun) continue;
    if (!first || r.lastRun < first) first = r.lastRun;
    if (!last || r.lastRun > last) last = r.lastRun;
    const day = runDays.get(dayOf(r.lastRun)) ?? { executed: 0, failed: 0 };
    day.executed += 1;
    if (r.outcome === "failed") day.failed += 1;
    runDays.set(dayOf(r.lastRun), day);
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
  const remaining = kpis.stillToRun;
  const daysToFinish = pacePerDay && remaining > 0 ? Math.ceil(remaining / pacePerDay) : remaining > 0 ? null : 0;
  const window = {
    first,
    last,
    text: options.windowText?.trim() || (first && last ? windowText(first, last) : null),
  };

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

  // Scope: runs per module, baseline vs in scope.
  const scopeRows: ScopeRow[] = [...new Set([...runsByModule.keys(), ...baseByModule.keys()])].map((id) => {
    const mine = runsByModule.get(id) ?? [];
    const base = baseByModule.get(id) ?? [];
    const inBoth = mine.filter((r) => baseKeys.has(r.key)).length;
    return {
      id,
      name: nameOf(id),
      baseline: base.length,
      inScope: mine.length,
      both: inBoth,
      deferred: base.length - inBoth,
      added: mine.length - inBoth,
      coveragePct: pct(inBoth, base.length),
      baselineStreams: splitOf(base),
      scopedStreams: splitOf(mine),
    };
  });
  scopeRows.sort((a, b) => b.inScope - a.inScope || b.baseline - a.baseline || a.name.localeCompare(b.name));
  const caseRefs = (list: Run[]) =>
    [
      ...new Map(
        list.map((r) => [
          `${r.moduleId}:${r.testCaseId}`,
          {
            testCaseId: r.testCaseId,
            name: r.name,
            module: nameOf(r.moduleId),
          },
        ]),
      ).values(),
    ].sort((a, b) => a.module.localeCompare(b.module) || a.testCaseId - b.testCaseId);
  const addedCases = hasBaseline ? caseRefs(runs.filter((r) => !baseKeys.has(r.key))) : [];
  const deferredCases = caseRefs(baseRuns.filter((r) => !runKeys.has(r.key)));

  // Data checks.
  const findings: Finding[] = [];
  const modulesOf = (cases: CaseRef[]) => list([...new Set(cases.map((c) => c.module))].sort());
  if (failedWithoutDefect.length) {
    findings.push({
      severity: "High",
      check: "Failed results with no linked defect",
      appliesTo: modulesOf(failedWithoutDefect),
      detail: `${failedWithoutDefect.length} of ${failedChecked.length} failed cases have no defect in Spira`,
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
  if (open.length && openCritical) {
    findings.push({
      severity: "High",
      check: "Open Critical defects",
      appliesTo: list(
        open
          .filter((d) => d.severity === "Critical")
          .slice(0, 4)
          .map((d) => `IN:${d.incident.incidentId}`),
      ),
      detail: `${openCritical} open`,
    });
  }
  const unrated = open.filter((d) => d.severity === "Not set" || d.priority === "Not set");
  if (unrated.length) {
    findings.push({
      severity: "Medium",
      check: "Severity or priority not set",
      appliesTo: "Open defects",
      detail: `${unrated.length} of ${open.length} open defects`,
    });
  }
  if (notStarted.length) {
    findings.push({
      severity: "Medium",
      check: "Modules not started",
      appliesTo: list(notStarted.map((m) => m.name)),
      detail: plural(
        notStarted.reduce((n, m) => n + m.inScope, 0),
        "planned run",
      ),
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
  const differing = caseRefs(
    [...groupBy(runs, (r) => `${r.moduleId}:${r.testCaseId}`).values()]
      .filter((list) => new Set(list.filter((r) => isExecuted(r.outcome)).map((r) => (r.outcome === "caution" ? "passed" : r.outcome))).size > 1)
      .map((list) => list[0]),
  );
  if (differing.length) {
    findings.push({
      severity: "Medium",
      check: "Results differ between platforms",
      appliesTo: modulesOf(differing),
      detail: `${plural(differing.length, "case")} passed on one platform and not on another`,
    });
  }
  const multiPlatform = new Set(modules.filter((m) => m.streams.length > 1).map((m) => m.id));
  const gaps = caseRefs(
    [
      ...groupBy(
        runs.filter((r) => multiPlatform.has(r.moduleId)),
        (r) => `${r.moduleId}:${r.testCaseId}`,
      ).values(),
    ]
      .filter((list) => list.length < (modules.find((m) => m.id === list[0].moduleId)?.streams.length ?? 0))
      .map((list) => list[0]),
  );
  if (gaps.length) {
    findings.push({
      severity: "Medium",
      check: "Cases on one platform only",
      appliesTo: modulesOf(gaps),
      detail: `${plural(gaps.length, "case")} missing from another platform's test set of the module`,
    });
  }
  const oneSided = modules.filter((m) => m.streams.length > 1 && m.streams.some((s) => (m.byStream[s]?.executed ?? 0) === 0) && m.executed > 0);
  if (oneSided.length) {
    findings.push({
      severity: "Medium",
      check: "Results recorded on one platform only",
      appliesTo: list(oneSided.map((m) => m.name)),
      detail: oneSided.map((m) => `${m.name}: no results on ${list(m.streams.filter((s) => (m.byStream[s]?.executed ?? 0) === 0))}`).join("; "),
    });
  }
  if (hasBaseline && addedCases.length) {
    findings.push({
      severity: "Low",
      check: "Cases in scope but not in the baseline",
      appliesTo: modulesOf(addedCases),
      detail: `${plural(addedCases.length, "case")}, for example written during testing`,
    });
  }
  if (!input.incidentsComplete) {
    findings.push({
      severity: "Low",
      check: "Incident list may be incomplete",
      appliesTo: "Defects",
      detail: "Spira returned only its most recent incidents; linked defects are still included",
    });
  }
  const linksPartial = failedCases.some((c) => !c.checked);
  if (linksPartial) {
    findings.push({
      severity: "Low",
      check: "Defect links checked for some failures only",
      appliesTo: "Failed cases",
      detail: `${failedChecked.length} of ${failedCases.length} failed cases were checked`,
    });
  }

  // Comparison with the baseline cycle, on one platform.
  const compareStream: Stream | null = streams.includes("iOS") ? "iOS" : (streams[0] ?? null);
  const progressText = (p: StreamProgress | undefined, planned: boolean) =>
    !p
      ? planned
        ? "Not planned"
        : "—"
      : p.executed === 0
        ? planned
          ? `Not run (${p.total.toLocaleString()} planned)`
          : "Not started"
        : `${p.executed.toLocaleString()} run · ${p.outcomes.failed.toLocaleString()} failed${p.outcomes.blocked ? ` · ${p.outcomes.blocked.toLocaleString()} blocked` : ""}`;
  const movementOf = (m: ModuleRow, stream: Stream): [string, Movement] => {
    const before = m.baselineByStream[stream];
    const now = m.byStream[stream];
    if (!m.inBuild) return ["Later build", "neutral"];
    if (!now || now.executed === 0) return before && before.executed > 0 ? ["Rerun pending", "neutral"] : ["Not started", "neutral"];
    const failedBefore = before?.outcomes.failed ?? 0;
    const blockedBefore = before?.outcomes.blocked ?? 0;
    if (now.outcomes.failed > 0) {
      if (failedBefore === 0) return ["New defects found", "bad"];
      if (now.outcomes.failed < failedBefore) return [`${failedBefore - now.outcomes.failed} fewer failed`, "good"];
      return [now.outcomes.failed > failedBefore ? `${now.outcomes.failed - failedBefore} more failed` : "Still failing", "bad"];
    }
    if (now.outcomes.blocked > 0) return [`${now.outcomes.blocked} blocked`, "bad"];
    if (failedBefore && blockedBefore) return ["Failures and blocks cleared", "good"];
    if (failedBefore) return ["Failures cleared", "good"];
    if (blockedBefore) return ["Blocks cleared", "good"];
    if (now.executed === now.total - now.outcomes.notApplicable) return ["Fully executed", "good"];
    return [`${now.executed} of ${now.total} run`, "neutral"];
  };
  const cycle: CycleComparison | null =
    hasBaseline && compareStream
      ? {
          stream: compareStream,
          baselineName,
          scopedName,
          rows: [...modules, ...laterModules].map((m) => {
            const [movement, tone] = movementOf(m, compareStream);
            return {
              name: m.name,
              before: progressText(m.baselineByStream[compareStream], true),
              now: m.inBuild ? progressText(m.byStream[compareStream], false) : `Not in ${labels.name}`,
              movement,
              tone,
            };
          }),
        }
      : null;

  // Narrative.
  const by = (s: ModuleStatus) => modules.filter((m) => m.status === s);
  const ready = by("ready");
  const why: string[] = [];
  for (const m of by("ready")) {
    const quality = [
      m.checks.passOk === false ? `pass ${formatPct(m.passPct)} (below ${targets.passRatePct}%)` : `${formatPct(m.passPct)} pass`,
      m.outcomes.failed ? plural(m.outcomes.failed, "failed run") : "",
      m.outcomes.blocked ? plural(m.outcomes.blocked, "blocked run") : "",
      m.openDefects ? plural(m.openDefects, "open defect") : "",
    ].filter(Boolean);
    why.push(`${m.name}: fully executed (${plural(m.executed, "run")}${quality.length ? ` · ${quality.join(" · ")}` : ""}).`);
  }
  for (const m of by("atRisk")) {
    const failedRuns = m.outcomes.failed;
    const same = m.streams.length > 1 && m.samePerPlatform && failedRuns === m.failedCases * m.streams.length;
    const failures = failedRuns
      ? same
        ? `; the same ${plural(m.failedCases, "case")} failed on ${m.streams.length === 2 ? "both platforms" : "every platform"} (${plural(failedRuns, "failed run")})`
        : `; ${plural(m.failedCases, "case")} failed (${plural(failedRuns, "failed run")})`
      : "";
    const blocked = m.outcomes.blocked ? `, ${plural(m.outcomes.blocked, "blocked run")}` : "";
    const traced = m.openDefects ? `, traced to ${plural(m.openDefects, "open defect")}` : failedRuns ? ", with no defect linked" : "";
    const left = m.stillToRun ? `; ${plural(m.stillToRun, "run")} still to go` : "";
    why.push(
      `${m.name}: ${m.outcomes.passed.toLocaleString()} of ${plural(m.executed, "run")} passed (${formatPct(m.passPct)})${failures}${blocked}${traced}${left}.`,
    );
  }
  for (const m of by("inProgress")) {
    const failedRuns = m.outcomes.failed;
    const failures = failedRuns ? `, ${plural(m.failedCases, "case")} failed so far` : ", with no failures yet";
    why.push(`${m.name}: ${m.executed.toLocaleString()} of ${plural(m.executable, "run")} so far (${formatPct(m.passPct)} pass)${failures}.`);
  }
  if (notStarted.length) {
    why.push(`${list(notStarted.map((m) => m.name))}: ${runsText(splitOf(runs.filter((r) => notStarted.some((m) => m.id === r.moduleId))))} not yet started.`);
  }

  const failingModules = modules.filter((m) => m.outcomes.failed > 0).sort((a, b) => b.outcomes.failed - a.outcomes.failed);
  const headline = [
    `In ${scopedName}, ${kpis.executed.toLocaleString()} of ${plural(kpis.executable, "planned test run")} ${kpis.executed === 1 ? "has" : "have"} been executed (${formatPct(kpis.execPct)})${kpis.executed ? ` and ${formatPct(kpis.passPct)} passed` : ""}.`,
    `${ready.length} of ${plural(modules.length, "module")} ${ready.length === 1 ? "is" : "are"} ready for UAT.`,
    failingModules.length === 1
      ? kpis.outcomes.failed === 1
        ? `The only failure is in ${failingModules[0].name}.`
        : `All ${plural(kpis.outcomes.failed, "failure")} sit in ${failingModules[0].name}.`
      : failingModules.length
        ? `${plural(kpis.outcomes.failed, "failure")} across ${list(failingModules.map((m) => m.name))}; ${failingModules[0].name} has the most (${failingModules[0].outcomes.failed}).`
        : "",
  ]
    .filter(Boolean)
    .join(" ");

  const actions: ActionItem[] = [];
  if (openCriticalHigh) {
    actions.push({
      title: "Critical and High defects",
      detail: `${plural(openCriticalHigh, "open defect")} of Critical or High severity block sign-off.`,
      action: "Fix and retest these first; they decide the exit.",
    });
  }
  for (const m of failingModules.slice(0, 2)) {
    const mine = open.filter((d) => d.modules.includes(m.name));
    const highPriority = mine.filter((d) => d.priority === "Critical" || d.priority === "High");
    actions.push({
      title: `${m.name} quality`,
      detail: `${m.outcomes.passed.toLocaleString()} of ${m.executed.toLocaleString()} ${m.name} runs passed (${formatPct(m.passPct)}); ${plural(m.failedCases, "case")} failed${mine.length ? `, traced to ${plural(mine.length, "open defect")}` : ""}${highPriority.length ? `, ${highPriority.length} of them High priority` : ""}.`,
      action: highPriority.length
        ? `Fix the High-priority defects first (${list(highPriority.slice(0, 4).map((d) => `IN:${d.incident.incidentId}`))}${highPriority.length > 4 ? " and others" : ""}), then retest and regress ${m.name}.`
        : `Fix and retest the open defects, then regress ${m.name}.`,
    });
  }
  if (remaining > 0) {
    const pace = pacePerDay
      ? ` At the recent pace (about ${Math.round(pacePerDay).toLocaleString()} runs a day) that is about ${plural(daysToFinish ?? 0, "day")} of execution.`
      : "";
    const goLive =
      daysToGoLive !== null ? ` Go-live is ${daysToGoLive >= 0 ? `in ${plural(daysToGoLive, "day")}` : `${plural(-daysToGoLive, "day")} past`}.` : "";
    const notStartedRuns = notStarted.reduce((n, m) => n + m.inScope, 0);
    actions.push({
      title: "Remaining scope",
      detail: notStarted.length
        ? `${list(notStarted.map((m) => m.name))} (${runsText(splitOf(runs.filter((r) => notStarted.some((m) => m.id === r.moduleId))))}) ${notStarted.length === 1 ? "has" : "have"} not started${remaining > notStartedRuns ? `; ${plural(remaining - notStartedRuns, "other run")} still to go` : ""}.${pace}`
        : `${plural(remaining, "run")} still to go.${pace}`,
      action: `Schedule the next execution window.${goLive}`,
    });
  }
  const outside = open.filter((d) => d.phase === "out" || d.phase === "tbc");
  if (outside.length && labels.named) {
    const byFeature = groupBy(outside, (d) => d.feature || "Unassigned");
    const modulesOut = [...new Set(outside.flatMap((d) => d.modules))];
    actions.push({
      title: `Scope drift${modulesOut.length === 1 ? ` in ${modulesOut[0]}` : ""}`,
      detail: `${outside.length} of ${plural(open.length, "open defect")} ${outside.length === 1 ? "is" : "are"} in features outside the approved ${labels.name} list or awaiting confirmation: ${[...byFeature].map(([f, list]) => `${f} (${list.length})`).join(", ")}.`,
      action: `Confirm whether these features ship with ${labels.name}; raise the priority of those that do.`,
    });
  }
  const reporting: string[] = [];
  if (failedWithoutDefect.length)
    reporting.push(
      `${failedWithoutDefect.length} of ${plural(failedChecked.length, "failed case")} ${failedWithoutDefect.length === 1 ? "has" : "have"} no linked defect`,
    );
  if (unrated.length) reporting.push(`${plural(unrated.length, "open defect")} ${unrated.length === 1 ? "has" : "have"} no severity or priority`);
  for (const m of oneSided) reporting.push(`${m.name} has no results recorded on ${list(m.streams.filter((s) => (m.byStream[s]?.executed ?? 0) === 0))}`);
  if (reporting.length) {
    actions.push({
      title: "Reporting data",
      detail: `${reporting.join("; ")}.`,
      action: [
        failedWithoutDefect.length ? "Link the failed cases to their defects" : "",
        unrated.length ? "set severity and priority in Spira" : "",
        oneSided.length ? "record the missing platform results" : "",
      ]
        .filter(Boolean)
        .join(", ")
        .replace(/^./, (c) => c.toUpperCase())
        .concat("."),
    });
  }
  if (overdue.length) {
    actions.push({
      title: "Overdue test sets",
      detail: `${plural(overdue.length, "test set")} ${overdue.length === 1 ? "is" : "are"} past ${overdue.length === 1 ? "its" : "their"} planned date with cases still to run.`,
      action: "Re-plan these sets or run them in the next window.",
    });
  }
  if (retest.retest) {
    actions.push({
      title: "Fixes awaiting retest",
      detail: `${plural(retest.retest, "defect")} ${retest.retest === 1 ? "is" : "are"} fixed and ready to retest.`,
      action: "Retest on the next build and close or reopen them.",
    });
  }

  const planText = hasBaseline ? `${perPlatform(kpis.split.plan, baseStreams)}${baseStreams.length > 1 ? `, ${plural(plan, "run")}` : ""}` : "";
  const buildText = `${perPlatform(kpis.split.inScope, streams)}${streams.length > 1 ? `, ${plural(runs.length, "run")}` : ""}`;
  const addedSplit = splitOf(runs, (r) => !baseKeys.has(r.key));
  const addedPlatforms = STREAMS.filter((s) => (addedSplit[s] ?? 0) > 0);
  const addedText = addedPlatforms.length > 1 ? perPlatform(addedSplit, addedPlatforms) : `${kpis.added.toLocaleString()}${streams.length > 1 ? ` on ${addedPlatforms[0]}` : ""}`;
  const scopeNote = [
    window.text ? `${scopedName} ran ${window.text}.` : "",
    hasBaseline
      ? `Test cases were scoped from the full plan (${planText}) to ${labels.name} (${buildText}${kpis.added ? `, including ${addedText} added in testing` : ""}).`
      : `${labels.build}: ${buildText}.`,
    options.scoped.releaseId !== null
      ? `${labels.build} is every case in the test sets of release ${scopeLabel(catalog, { releaseId: options.scoped.releaseId, folderId: null })}${streams.length > 1 ? `, run on ${list(streams)}` : ""}.`
      : "",
    laterModules.length ? `${list(laterModules.map((m) => m.name))} ${laterModules.length === 1 ? "is" : "are"} not part of ${labels.name}.` : "",
    kpis.api.inScope ? `The API stream (${plural(kpis.api.inScope, "case")}, ${kpis.api.executed.toLocaleString()} executed) is reported separately.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const rollupExecuted = spiraRollup.passed + spiraRollup.failed + spiraRollup.blocked + spiraRollup.caution;
  const dataNote = [
    streams.length > 1
      ? differing.length
        ? `${plural(differing.length, "case")} ${differing.length === 1 ? "has" : "have"} different results on ${list(streams)}.`
        : `Every case run on more than one platform has the same result on each.`
      : "",
    oneSided.length ? `${list(oneSided.map((m) => m.name))} ${oneSided.length === 1 ? "has" : "have"} results on one platform only so far.` : "",
    `Spira's own test set roll-up shows ${spiraRollup.passed.toLocaleString()} passed and ${spiraRollup.failed.toLocaleString()} failed of ${rollupExecuted.toLocaleString()} executed${
      spiraRollup.passed === kpis.outcomes.passed && spiraRollup.failed === kpis.outcomes.failed
        ? ", matching this report"
        : "; this report counts each case once per platform from the cases read"
    }.`,
    hasBaseline ? `${baselineName} is used for the total plan and the comparison only.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    generatedAt,
    projectId: catalog.projectId,
    projectName: catalog.projectName,
    title: options.title.trim() || `${catalog.projectName} — Daily ${/^[A-Z]{2,5}\b/.exec(scopedName)?.[0] ?? ""} Test Report`.replace(/\s+/g, " "),
    environment: options.environment.trim(),
    preparedBy: options.preparedBy.trim(),
    kind: options.kind,
    hasBaseline,
    baselineLabel: scopeLabel(catalog, options.baseline),
    scopedLabel: scopeLabel(catalog, options.scoped),
    baselineName,
    scopedName,
    labels,
    streams,
    goLive: options.goLive,
    daysToGoLive,
    window,
    kpis,
    modules,
    laterModules,
    streamRows,
    readiness,
    criteria,
    bars,
    status: options.status === "auto" ? autoStatus : options.status,
    autoStatus,
    statusReason,
    defects,
    cycle,
    scope: {
      rows: scopeRows,
      streams: STREAMS.filter((s) => scopeRows.some((r) => r.baselineStreams[s] || r.scopedStreams[s])),
      added: addedCases,
      deferred: deferredCases,
    },
    findings,
    narrative: { headline, why, actions, scopeNote, dataNote },
    trend: { days: trendDays, earlier, pacePerDay, daysToFinish },
    testSets,
    baselineSets,
    failedCases,
    targets,
    notes: options.notes.trim(),
    appendix: options.appendix ?? false,
    sources: {
      incidentsComplete: input.incidentsComplete,
      linksPartial,
      setsRead: Object.keys(input.results).length,
      setsMissing,
    },
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
    else if (m.inScope !== p.inScope) [movement, tone] = [`Scope ${m.inScope > p.inScope ? "+" : ""}${m.inScope - p.inScope} runs`, "neutral"];
    else [movement, tone] = ["No change", "neutral"];
    rows.push({ name: m.name, before: progressText(p), now: progressText(m), movement, tone });
  }
  for (const p of previous.modules) if (!now.has(p.id)) rows.push({ name: p.name, before: progressText(p), now: "Not in scope", movement: "Removed from scope", tone: "neutral" });
  return rows;
}
