import {
  classifySet,
  folderPath,
  MAX_REPORT_SETS,
  OUTCOME_LABEL,
  outcomeOf,
  scopeLabel,
  setsInScope,
  type ReportOptions,
  type ReportScope,
} from "@/lib/domain/report";
import type { ReportCase, ReportCatalog, TestSetMapping } from "@/lib/domain/types";
import { api } from "./api";
import type { ReportProgress } from "./report";

type Workbook = import("exceljs").Workbook;

function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]+/g, "-").slice(0, 31) || "Sheet";
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "test-cases";
}

async function inBatches<T>(items: T[], size: number, workers: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, batches.length || 1) }, async () => {
      while (next < batches.length) await run(batches[next++]);
    }),
  );
}

/** Rows for one release/folder scope: every case in every test set, once per platform set. */
export function caseExportRows(
  catalog: ReportCatalog,
  scope: ReportScope,
  mappings: TestSetMapping[],
  results: Record<number, ReportCase[]>,
  siteUrl: string | null,
): Array<Record<string, unknown>> {
  const sets = setsInScope(catalog, scope);
  const rows: Array<Record<string, unknown>> = [];
  for (const set of sets) {
    const { module, stream } = classifySet(set, catalog.folders, mappings);
    const folder = folderPath(catalog.folders, set.folderId).join(" / ");
    for (const c of results[set.testSetId] ?? []) {
      const outcome = outcomeOf(c.statusId);
      rows.push({
        Module: module,
        Platform: stream,
        "Test set": set.name,
        "Test set ID": set.testSetId,
        Folder: folder || "—",
        Release: set.releaseVersion ?? "",
        "TC ID": c.testCaseId,
        Name: c.name,
        Priority: c.priority ?? "",
        Status: OUTCOME_LABEL[outcome],
        "Last run": c.executionDate ? c.executionDate.slice(0, 10) : "",
        Link: siteUrl ? `${siteUrl}/${catalog.projectId}/TestCase/${c.testCaseId}.aspx` : "",
      });
    }
  }
  return rows.sort(
    (a, b) =>
      String(a.Module).localeCompare(String(b.Module)) ||
      String(a.Platform).localeCompare(String(b.Platform)) ||
      String(a["Test set"]).localeCompare(String(b["Test set"])) ||
      Number(a["TC ID"]) - Number(b["TC ID"]),
  );
}

async function writeCasesWorkbook(fileLabel: string, sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>): Promise<void> {
  const ExcelJS = await import("exceljs");
  const wb: Workbook = new ExcelJS.Workbook();
  wb.creator = "Spira Test Set Reconciler";
  wb.created = new Date();

  for (const { name, rows } of sheets) {
    const data = rows.length ? rows : [{ Note: "No test cases in this scope." }];
    const keys = Object.keys(data[0]);
    const sheet = wb.addWorksheet(safeSheetName(name), { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(keys);
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.height = 20;
    for (const row of data) sheet.addRow(keys.map((k) => row[k] ?? ""));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.length + 1, column: keys.length } };
    sheet.columns.forEach((col) => {
      let width = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const text = cell.text ?? (cell.value == null ? "" : String(cell.value));
        width = Math.max(width, Math.min(48, text.length + 2));
      });
      col.width = width;
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(fileLabel)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Reads every test case in the chosen Spira scope (release/folder) and downloads an Excel file.
 * Names and status only — step text is not pulled (keeps the download fast for large SIT packs).
 */
export async function downloadScopeTestCases(input: {
  catalog: ReportCatalog;
  options: Pick<ReportOptions, "kind" | "scoped" | "baseline" | "environment" | "baselineName">;
  mappings: TestSetMapping[];
  siteUrl: string | null;
  onProgress?: (progress: ReportProgress) => void;
  signal?: AbortSignal;
}): Promise<{ cases: number; sets: number }> {
  const { catalog, options, mappings, siteUrl, signal } = input;
  const progress = input.onProgress ?? (() => undefined);
  const projectId = catalog.projectId;

  const scopes: Array<{ key: string; scope: ReportScope; sheet: string }> = [
    { key: "scoped", scope: options.scoped, sheet: scopeLabel(catalog, options.scoped) || options.environment || "In scope" },
  ];
  if (options.kind === "buildVsPlan" && options.baseline.releaseId !== null) {
    scopes.push({
      key: "baseline",
      scope: options.baseline,
      sheet: options.baselineName.trim() || scopeLabel(catalog, options.baseline) || "Baseline / plan",
    });
  }

  const setIds = [...new Set(scopes.flatMap((s) => setsInScope(catalog, s.scope).map((set) => set.testSetId)))];
  if (setIds.length === 0) throw new Error("No test sets in the chosen release. Pick a SIT or build release that has test sets.");

  const results: Record<number, ReportCase[]> = {};
  progress({ step: "Reading test cases from Spira", done: 0, total: setIds.length });
  await inBatches(setIds, MAX_REPORT_SETS, 3, async (batch) => {
    const out = await api<{ results: Record<string, ReportCase[]> }>("/api/reports/results", {
      method: "POST",
      body: { projectId, testSetIds: batch },
      signal,
    });
    for (const [id, cases] of Object.entries(out.results)) results[Number(id)] = cases;
    progress({ step: "Reading test cases from Spira", done: Object.keys(results).length, total: setIds.length });
  });

  const sheets = scopes.map(({ scope, sheet }) => ({
    name: sheet,
    rows: caseExportRows(catalog, scope, mappings, results, siteUrl),
  }));
  const cases = sheets.reduce((n, s) => n + s.rows.length, 0);
  const label = `Spira test cases ${sheets[0]?.name ?? "export"} ${new Date().toISOString().slice(0, 10)}`;
  progress({ step: "Building Excel", done: setIds.length, total: setIds.length });
  await writeCasesWorkbook(label, sheets);
  return { cases, sets: setIds.length };
}
