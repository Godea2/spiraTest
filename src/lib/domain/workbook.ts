import * as XLSX from "xlsx";
import { moduleKey } from "./test-set-suggest";
import type { CellValue, WorkbookRow, WorkbookScope } from "./types";

export const DEFAULT_IN_SCOPE_SHEET = "Phase 1 In-Scope";
export const DEFAULT_NEEDS_CONFIRMATION_SHEET = "Needs Confirmation";
export const HEADER_SEARCH_ROWS = 15;
export const REQUIRED_HEADERS = ["TC ID", "Test Scenario"] as const;

export class WorkbookError extends Error {}

export function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function readWorkbook(data: ArrayBuffer): XLSX.WorkBook {
  try {
    return XLSX.read(data, { type: "array", cellDates: true });
  } catch {
    throw new WorkbookError("This file could not be read as an Excel workbook.");
  }
}

export function pickDefaultSheet(sheetNames: string[], preferred: string): string | null {
  const wanted = normalizeText(preferred);
  return sheetNames.find((name) => normalizeText(name) === wanted) ?? null;
}

function cellToValue(value: unknown): CellValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((cell, index) => {
    const base = String(cell ?? "").trim() || `Column ${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

export function findHeaderRow(matrix: unknown[][]): number {
  const required = REQUIRED_HEADERS.map(normalizeText);
  const limit = Math.min(matrix.length, HEADER_SEARCH_ROWS);
  for (let i = 0; i < limit; i += 1) {
    const cells = new Set((matrix[i] ?? []).map(normalizeText));
    if (required.every((header) => cells.has(header))) return i;
  }
  return -1;
}

export function parseSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
  scope: WorkbookScope,
): { headers: string[]; rows: WorkbookRow[] } {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new WorkbookError(`Sheet "${sheetName}" was not found in this workbook.`);
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: true,
    raw: true,
  });
  const headerIndex = findHeaderRow(matrix);
  if (headerIndex < 0) {
    throw new WorkbookError(
      `Sheet "${sheetName}" needs a header row with "TC ID" and "Test Scenario" within the first ${HEADER_SEARCH_ROWS} rows.`,
    );
  }
  const headers = uniqueHeaders(matrix[headerIndex] ?? []);
  const rows: WorkbookRow[] = [];
  for (let i = headerIndex + 1; i < matrix.length; i += 1) {
    const raw = matrix[i] ?? [];
    const values: Record<string, CellValue> = {};
    let hasContent = false;
    headers.forEach((header, col) => {
      const value = cellToValue(raw[col]);
      if (value !== null) hasContent = true;
      values[header] = value;
    });
    if (hasContent) rows.push({ sheet: sheetName, rowNumber: i + 1, scope, values });
  }
  return { headers, rows };
}

export function findModuleHeader(headers: string[]): string | null {
  return headers.find((header) => normalizeText(header) === "module") ?? null;
}

export function moduleNames(rows: WorkbookRow[]): string[] {
  const names = new Map<string, string>();
  for (const row of rows) {
    const header = findModuleHeader(Object.keys(row.values));
    const value = header ? row.values[header] : null;
    if (value === null || value === undefined) continue;
    const label = String(value).trim();
    if (label) names.set(normalizeText(label), label);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/** Matches the module's canonical name or its configured Excel alias, ignoring case, spacing and a plural "s". */
export function filterRowsByModule(
  rows: WorkbookRow[],
  moduleName: string,
  alias?: string | null,
): WorkbookRow[] {
  const accepted = new Set([moduleKey(moduleName)]);
  if (alias && alias.trim()) accepted.add(moduleKey(alias));
  return rows.filter((row) => {
    const header = findModuleHeader(Object.keys(row.values));
    if (!header) return false;
    const value = row.values[header];
    return value !== null && value !== undefined && accepted.has(moduleKey(String(value)));
  });
}

export interface ParsedWorkbook {
  sheetNames: string[];
  rows: WorkbookRow[];
  hasModuleColumn: boolean;
}

export function parseWorkbookRows(
  workbook: XLSX.WorkBook,
  inScopeSheet: string,
  needsConfirmationSheet: string | null,
): ParsedWorkbook {
  const inScope = parseSheet(workbook, inScopeSheet, "inScope");
  const confirmation = needsConfirmationSheet
    ? parseSheet(workbook, needsConfirmationSheet, "needsConfirmation")
    : { headers: [], rows: [] };
  const hasModuleColumn =
    findModuleHeader(inScope.headers) !== null ||
    (needsConfirmationSheet !== null && findModuleHeader(confirmation.headers) !== null);
  return {
    sheetNames: workbook.SheetNames,
    rows: [...inScope.rows, ...confirmation.rows],
    hasModuleColumn,
  };
}
