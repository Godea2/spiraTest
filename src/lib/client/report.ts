import {
  addSnapshot,
  defaultReportOptions,
  formatPct,
  OUTCOME_LABEL,
  OUTCOMES,
  snapshotOf,
  type Report,
  type ReportInput,
  type ReportOptions,
  type ReportSnapshot,
} from "@/lib/domain/report";
import { collectReportData, type ReportProgress } from "@/lib/domain/report-read";
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

export type { ReportProgress };

const numericKeys = <T>(record: Record<string, T>): Record<number, T> => Object.fromEntries(Object.entries(record).map(([k, v]) => [Number(k), v]));

/** Reads everything the report needs from Spira, through the server and read-only. */
export async function readReportData(input: {
  catalog: ReportCatalog;
  options: ReportOptions;
  mappings: TestSetMapping[];
  onProgress: (progress: ReportProgress) => void;
  signal?: AbortSignal;
}): Promise<ReportInput> {
  const { catalog, signal } = input;
  const projectId = catalog.projectId;
  return collectReportData({
    ...input,
    reader: {
      results: async (testSetIds) =>
        numericKeys((await api<{ results: Record<string, ReportCase[]> }>("/api/reports/results", { method: "POST", body: { projectId, testSetIds }, signal })).results),
      links: async (testCaseIds) => {
        const out = await api<{ links: Record<string, number[]>; incidents: ReportIncident[] }>("/api/reports/links", { method: "POST", body: { projectId, testCaseIds }, signal });
        return { links: numericKeys(out.links), incidents: out.incidents };
      },
      incidents: () => api<{ incidents: ReportIncident[]; complete: boolean }>("/api/reports/incidents", { method: "POST", body: { projectId }, signal }),
    },
  });
}

/** A public, read-only link to the report: it is read live from Spira by the server each time it is opened. */
export async function createShareLink(input: {
  projectId: number;
  options: ReportOptions;
  mappings: TestSetMapping[];
  days: number;
}): Promise<{ url: string; expiresAt: string }> {
  const { path, expiresAt } = await api<{ path: string; expiresAt: string }>("/api/reports/share", { method: "POST", body: input });
  return { url: `${window.location.origin}${path}`, expiresAt };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

type SheetLike = {
  "!cols"?: Array<{ wch: number }>;
};

/** Column widths from content so sheets open looking like a proper table, not cramped defaults. */
export function fitSheetColumns(sheet: SheetLike, sampleRows: Array<Record<string, unknown>>, min = 8, max = 48): void {
  if (sampleRows.length === 0) return;
  const keys = Object.keys(sampleRows[0]);
  sheet["!cols"] = keys.map((key) => {
    let w = Math.min(max, Math.max(min, key.length + 2));
    for (const row of sampleRows.slice(0, 80)) {
      const text = row[key] == null ? "" : String(row[key]);
      w = Math.max(w, Math.min(max, text.length + 2));
    }
    return { wch: w };
  });
}

/** Cover-style Summary grid matching the on-screen executive report sections. */
export function buildReportSummaryGrid(report: Report): (string | number)[][] {
  const k = report.kpis;
  const blank: (string | number)[] = [];
  const row = (label: string, value: string | number = ""): (string | number)[] => [label, value];
  const section = (title: string): (string | number)[] => [title, ""];
  return [
    row("Report", report.title),
    row("Overall status", report.status.toUpperCase()),
    row("Status reason", report.statusReason),
    row("Project", `${report.projectName} (${report.projectId})`),
    row("Cycle", report.environment),
    row("In scope", report.scopedLabel),
    row("Baseline", report.baselineLabel),
    row("Prepared by", report.preparedBy),
    row("Go-live", report.goLive ?? ""),
    row("Read from Spira", when(report.generatedAt)),
    row("Executions", report.window.text ?? ""),
    row("Counted as", "Test runs: each case once per platform it is planned on"),
    blank,
    section("Key figures"),
    row("Total test plan (runs)", k.plan),
    row(`${report.labels.build} (runs)`, k.inScope),
    row("Later builds (runs)", k.laterBuilds),
    row("Executed", k.executed),
    row("Executed %", formatPct(k.execPct)),
    ...OUTCOMES.map((o) => row(OUTCOME_LABEL[o], k.outcomes[o])),
    row("Still to run", k.stillToRun),
    row("Pass rate", formatPct(k.passPct)),
    row("Open defects", report.defects.open),
    row("Added in testing (runs)", k.added),
    row(`${report.baselineName} pass rate`, formatPct(k.baseline.passPct)),
    row("API cases (not counted above)", k.api.inScope),
    blank,
    section("By platform"),
    ...report.streams.map((s) =>
      row(
        s,
        `${k.split.inScope[s] ?? 0} in scope · ${k.split.executed[s] ?? 0} executed · ${k.split.passed[s] ?? 0} passed · ${k.split.failed[s] ?? 0} failed`,
      ),
    ),
    blank,
    section("Narrative"),
    row("Headline", report.narrative.headline),
    row("Why each module has its status", report.narrative.why.join(" ")),
    row("Scope note", report.narrative.scopeNote),
    row("Data note", report.narrative.dataNote),
    row("QA notes", report.notes),
  ];
}

/** Styled Excel workbook (cover Summary + section tables) matching the on-screen report. */
export async function exportReportWorkbook(report: Report, siteUrl: string | null): Promise<void> {
  const { exportReportWorkbookStyled } = await import("./report-excel");
  await exportReportWorkbookStyled(report, siteUrl);
}
