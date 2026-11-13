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
import { CYCLE_PRESETS } from "@/lib/domain/settings";
import {
  groupRowsByModule,
  groupRowsByStatus,
  overallCounts,
  safeSheetName as uniqueSheetName,
  STATUS_ORDER,
  summarizeByModulePlatform,
  toCaseRows,
  type CaseRow,
} from "@/lib/domain/testcase-workbook";
import type { ReportCase, ReportCatalog, TestSetMapping } from "@/lib/domain/types";
import { api } from "./api";
import type { ReportProgress } from "./report";

type Workbook = import("exceljs").Workbook;
type Worksheet = import("exceljs").Worksheet;

function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]+/g, "-").slice(0, 31) || "Sheet";
}

const FILL = {
  header: "FF0F172A",
  section: "FFE2E8F0",
  zebra: "FFF8FAFC",
  passed: "FFDCFCE7",
  failed: "FFFEE2E2",
  blocked: "FFFEF3C7",
  caution: "FFFFF7ED",
  notRun: "FFF1F5F9",
  white: "FFFFFFFF",
} as const;

function fillSolid(argb: string) {
  return { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } };
}

function thinBorder() {
  const edge = { style: "thin" as const, color: { argb: "FFCBD5E1" } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function statusFill(status: string): string | null {
  const s = status.trim().toLowerCase();
  if (s === "passed") return FILL.passed;
  if (s === "failed") return FILL.failed;
  if (s === "blocked") return FILL.blocked;
  if (s === "caution") return FILL.caution;
  if (s === "not run" || s === "n/a") return FILL.notRun;
  return null;
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

const CASE_COLUMNS: Array<keyof CaseRow> = [
  "TC ID",
  "Name",
  "Module",
  "Platform",
  "Test set",
  "Priority",
  "Status",
  "Last run",
  "Link",
];

function styleCaseHeader(sheet: Worksheet, colCount: number): void {
  const row = sheet.getRow(1);
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = fillSolid(FILL.header);
    cell.font = { bold: true, color: { argb: FILL.white }, size: 10, name: "Calibri" };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = thinBorder();
  }
  row.height = 22;
}

function addStyledCaseSheet(wb: Workbook, name: string, rows: CaseRow[], usedNames: Set<string>): void {
  const sheet = wb.addWorksheet(uniqueSheetName(name, usedNames), {
    views: [{ state: "frozen", ySplit: 1, activeCell: "A2" }],
  });
  const data = rows.length ? rows : [];
  sheet.addRow(CASE_COLUMNS);
  styleCaseHeader(sheet, CASE_COLUMNS.length);
  data.forEach((row, i) => {
    const excelRow = sheet.addRow(CASE_COLUMNS.map((k) => row[k]));
    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = CASE_COLUMNS[colNumber - 1];
      cell.border = thinBorder();
      cell.font = { name: "Calibri", size: 10, color: { argb: "FF0F172A" } };
      cell.alignment = { vertical: "middle", wrapText: key === "Name" };
      if (i % 2 === 1) cell.fill = fillSolid(FILL.zebra);
      if (key === "Status") {
        const bg = statusFill(String(row.Status));
        if (bg) cell.fill = fillSolid(bg);
        cell.font = { ...cell.font, bold: true };
      }
      if (key === "Link" && typeof row.Link === "string" && /^https?:\/\//i.test(row.Link)) {
        cell.value = { text: "Open in Spira", hyperlink: row.Link };
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF4338CA" }, underline: true };
      }
    });
  });
  if (data.length) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: data.length + 1, column: CASE_COLUMNS.length } };
  }
  sheet.columns.forEach((col, idx) => {
    const key = CASE_COLUMNS[idx];
    col.width = key === "Name" ? 48 : key === "Link" ? 16 : key === "Test set" ? 28 : key === "Module" ? 22 : 12;
  });
}

function addReadMeSheet(
  wb: Workbook,
  meta: { environment: string; releaseLabel: string; projectName: string; generatedAt: string; caseCount: number },
): void {
  const sheet = wb.addWorksheet("Read Me", { views: [{ showGridLines: false }] });
  const lines: Array<[string, string]> = [
    ["Title", `${meta.projectName} — ${meta.environment} testcase workbook`],
    ["Environment", meta.environment],
    ["Spira release", meta.releaseLabel],
    ["Generated", meta.generatedAt],
    ["Cases", String(meta.caseCount)],
    ["", ""],
    ["Purpose", "Authoritative inventory of Spira test cases for this build, with live execution status."],
    ["Source", "Spira test sets planned for the release. Status is the latest result Spira shows per case membership."],
    ["Sheets", "Master = all cases. Summary = module × platform counts. By Status = each outcome. Then one sheet per module."],
    ["Not included", "Step text, BRD / Req IDs, and Figma links (those live in the design master workbook, not Spira)."],
    ["Platforms", "Android and iOS appear as separate rows when the case is in both platform test sets."],
  ];
  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 88;
  sheet.getCell("A1").value = "UBA Mobile / Project-Simba — Functional testcase pack";
  sheet.getCell("A1").font = { name: "Calibri", size: 16, bold: true, color: { argb: "FF0F172A" } };
  sheet.mergeCells("A1:B1");
  sheet.getRow(1).height = 26;
  let r = 3;
  for (const [label, value] of lines) {
    if (!label && !value) {
      r += 1;
      continue;
    }
    sheet.getCell(r, 1).value = label;
    sheet.getCell(r, 1).font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF334155" } };
    sheet.getCell(r, 2).value = value;
    sheet.getCell(r, 2).font = { name: "Calibri", size: 10, color: { argb: "FF0F172A" } };
    sheet.getCell(r, 2).alignment = { wrapText: true };
    r += 1;
  }
}

function addSummaryPivotSheet(wb: Workbook, rows: CaseRow[], usedNames: Set<string>): void {
  const sheet = wb.addWorksheet(uniqueSheetName("Summary", usedNames), { views: [{ showGridLines: false }] });
  const totals = overallCounts(rows);
  const executed = totals.Passed + totals.Failed + totals.Blocked + totals.Caution;
  const passRate = executed === 0 ? "—" : `${Math.round((totals.Passed / executed) * 100)}%`;

  sheet.getCell("A1").value = "Execution summary";
  sheet.getCell("A1").font = { name: "Calibri", size: 14, bold: true };
  sheet.mergeCells("A1:D1");

  const headline: Array<[string, string | number]> = [
    ["Total cases", totals.Total],
    ["Passed", totals.Passed],
    ["Failed", totals.Failed],
    ["Blocked", totals.Blocked],
    ["Caution", totals.Caution],
    ["Not Run", totals["Not Run"]],
    ["Pass rate (of executed)", passRate],
  ];
  let r = 3;
  for (const [label, value] of headline) {
    sheet.getCell(r, 1).value = label;
    sheet.getCell(r, 1).font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF334155" } };
    sheet.getCell(r, 2).value = value;
    sheet.getCell(r, 2).font = { name: "Calibri", size: 10, bold: true };
    const bg = statusFill(label);
    if (bg) sheet.getCell(r, 2).fill = fillSolid(bg);
    r += 1;
  }

  r += 1;
  sheet.getCell(r, 1).value = "By module and platform";
  sheet.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true };
  sheet.getCell(r, 1).fill = fillSolid(FILL.section);
  sheet.mergeCells(r, 1, r, 10);
  r += 1;

  const pivot = summarizeByModulePlatform(rows);
  const keys = ["Module", "Platform", "Passed", "Failed", "Blocked", "Caution", "Not Run", "Other", "Total", "Pass rate"] as const;
  const headerRow = sheet.getRow(r);
  keys.forEach((k, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = k;
    cell.fill = fillSolid(FILL.header);
    cell.font = { bold: true, color: { argb: FILL.white }, size: 10, name: "Calibri" };
    cell.border = thinBorder();
  });
  headerRow.height = 22;
  r += 1;
  for (const row of pivot) {
    const excelRow = sheet.getRow(r);
    keys.forEach((k, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.value = row[k];
      cell.border = thinBorder();
      cell.font = { name: "Calibri", size: 10 };
    });
    r += 1;
  }
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 12;
  for (let c = 3; c <= 10; c += 1) sheet.getColumn(c).width = 11;
}

function addByStatusSheet(wb: Workbook, rows: CaseRow[], usedNames: Set<string>): void {
  const sheet = wb.addWorksheet(uniqueSheetName("By Status", usedNames), {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const grouped = groupRowsByStatus(rows);
  sheet.addRow(["Status", ...CASE_COLUMNS]);
  styleCaseHeader(sheet, CASE_COLUMNS.length + 1);
  let r = 2;
  for (const status of STATUS_ORDER) {
    const list = grouped.get(status) ?? [];
    if (list.length === 0) continue;
    for (const row of list) {
      const excelRow = sheet.getRow(r);
      excelRow.getCell(1).value = status;
      CASE_COLUMNS.forEach((k, i) => {
        excelRow.getCell(i + 2).value = row[k];
      });
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = thinBorder();
        cell.font = { name: "Calibri", size: 10 };
      });
      const bg = statusFill(status);
      if (bg) excelRow.getCell(1).fill = fillSolid(bg);
      r += 1;
    }
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(2, r - 1), column: CASE_COLUMNS.length + 1 } };
  sheet.getColumn(1).width = 10;
  sheet.getColumn(3).width = 42;
}

async function writeProfessionalTestcaseWorkbook(input: {
  projectName: string;
  environment: string;
  releaseLabel: string;
  rows: CaseRow[];
}): Promise<void> {
  const ExcelJS = await import("exceljs");
  const wb: Workbook = new ExcelJS.Workbook();
  wb.creator = "Spira Test Set Reconciler";
  wb.created = new Date();
  wb.title = `${input.projectName} ${input.environment} testcases`;

  const used = new Set<string>();
  const generatedAt = new Date().toISOString();
  addReadMeSheet(wb, {
    environment: input.environment,
    releaseLabel: input.releaseLabel,
    projectName: input.projectName,
    generatedAt,
    caseCount: input.rows.length,
  });
  used.add("read me");

  addSummaryPivotSheet(wb, input.rows, used);
  addByStatusSheet(wb, input.rows, used);
  addStyledCaseSheet(wb, "Master", input.rows, used);

  for (const [module, moduleRows] of groupRowsByModule(input.rows)) {
    addStyledCaseSheet(wb, module, moduleRows, used);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const day = generatedAt.slice(0, 10);
  a.download = `${safeFileName(`${input.projectName} ${input.environment} Testcases ${day}`)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Professional multi-sheet testcase pack for SIT or UAT: Read Me, Summary, By Status, Master, one sheet per module.
 * Status comes from Spira (no step text).
 */
export async function downloadEnvironmentTestcaseWorkbook(input: {
  catalog: ReportCatalog;
  cycle: "sit" | "uat";
  releaseId: number;
  releaseLabel: string;
  mappings: TestSetMapping[];
  siteUrl: string | null;
  onProgress?: (progress: ReportProgress) => void;
  signal?: AbortSignal;
}): Promise<{ cases: number; sets: number; environment: string }> {
  const { catalog, cycle, releaseId, releaseLabel, mappings, siteUrl, signal } = input;
  const progress = input.onProgress ?? (() => undefined);
  const environment = cycle === "sit" ? "SIT Cycle 2" : "UAT Cycle 1";
  const preset = CYCLE_PRESETS[cycle];
  const scope: ReportScope = { releaseId, folderId: null };
  const sets = setsInScope(catalog, scope);
  if (sets.length === 0) {
    throw new Error(`No Spira test sets for ${environment} (RL:${releaseId}). Check the release is planned in Project-Simba.`);
  }

  const setIds = sets.map((s) => s.testSetId);
  const results: Record<number, ReportCase[]> = {};
  progress({ step: `Reading ${environment} cases from Spira`, done: 0, total: setIds.length });
  await inBatches(setIds, MAX_REPORT_SETS, 3, async (batch) => {
    const out = await api<{ results: Record<string, ReportCase[]> }>("/api/reports/results", {
      method: "POST",
      body: { projectId: catalog.projectId, testSetIds: batch },
      signal,
    });
    for (const [id, cases] of Object.entries(out.results)) results[Number(id)] = cases;
    progress({ step: `Reading ${environment} cases from Spira`, done: Object.keys(results).length, total: setIds.length });
  });

  const exportRows = caseExportRows(catalog, scope, mappings, results, siteUrl);
  const rows = toCaseRows(exportRows);
  progress({ step: "Building professional workbook", done: setIds.length, total: setIds.length });
  await writeProfessionalTestcaseWorkbook({
    projectName: catalog.projectName || "Project-Simba",
    environment,
    releaseLabel: releaseLabel || preset.releaseLabel,
    rows,
  });
  return { cases: rows.length, sets: setIds.length, environment };
}
