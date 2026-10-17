import { wordingSimilarity } from "./defects";
import type { ExecutionStatus, Platform } from "./types";

export const MAX_IMPORT_ROWS = 80;
export const MAX_IMPORT_CELL = 4_000;

/** Columns we can recognise on a colleague's progress / issue sheet. Names are matched loosely. */
export type ImportField =
  | "sn"
  | "module"
  | "feature"
  | "issue"
  | "status"
  | "retest"
  | "platform"
  | "severity"
  | "testerComment"
  | "devComment";

const FIELD_ALIASES: Record<ImportField, string[]> = {
  sn: ["s/n", "sn", "s n", "no", "#", "id", "item"],
  module: ["module", "area module", "test module"],
  feature: ["feature / area", "feature/area", "feature", "area", "feature area", "screen"],
  issue: ["issue observed", "issue", "observation", "defect", "bug", "description", "what went wrong"],
  status: ["status", "issue status", "current status"],
  retest: ["retest result", "re-test result", "retest", "re-test", "test result", "result", "qa result"],
  platform: ["platform / device", "platform/device", "platform", "device", "os"],
  severity: ["severity", "sev", "priority"],
  testerComment: ["tester's comment", "testers comment", "tester comment", "qa comment", "retest comment"],
  devComment: ["developer's comment", "developers comment", "dev comment", "developing team comment"],
};

export interface ImportColumnMap {
  /** Header text as in the sheet, keyed by the field we use it for. */
  fields: Partial<Record<ImportField, string>>;
  /** Every header on the header row, for the UI. */
  headers: string[];
  headerRow: number;
}

export interface ImportSheetRow {
  /** 1-based sheet row number. */
  rowNumber: number;
  sn: string;
  module: string;
  feature: string;
  issue: string;
  status: string;
  retest: string;
  platform: string;
  severity: string;
  testerComment: string;
  devComment: string;
  /** Text Gemini and the tester use to find cases. */
  query: string;
}

export interface ImportSheet {
  sheetName: string;
  map: ImportColumnMap;
  rows: ImportSheetRow[];
  /** Rows that look like they carry a result we can write to Spira. */
  actionable: number;
  skipped: number;
}

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^\p{L}\p{N}/]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const cellText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).replace(/\r\n/g, "\n").trim().slice(0, MAX_IMPORT_CELL);
};

/** Best matching field for a header, or null when it is not one we use. */
export function fieldForHeader(header: string): ImportField | null {
  const h = norm(header);
  if (!h) return null;
  let best: { field: ImportField; score: number } | null = null;
  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as Array<[ImportField, string[]]>) {
    for (const alias of aliases) {
      const a = norm(alias);
      let score = 0;
      if (h === a) score = 100;
      else if (h.startsWith(`${a} `) || a.startsWith(`${h} `) || h.startsWith(`${a}/`) || h.startsWith(`${a}(`)) score = 80;
      else if (` ${h} `.includes(` ${a} `) && a.length >= 4) score = 55 + Math.min(a.length, 20);
      else score = Math.round(wordingSimilarity(h, a) * 40);
      if (score >= 55 && (!best || score > best.score)) best = { field, score };
    }
  }
  return best?.field ?? null;
}

/**
 * Finds the header row of a progress / issue sheet: needs a Module (or Feature) column and at least
 * one of Issue, Status or Retest. Looks in the first 25 rows.
 */
export function findImportHeader(matrix: unknown[][]): ImportColumnMap | null {
  const limit = Math.min(matrix.length, 25);
  let best: ImportColumnMap | null = null;
  let bestScore = 0;
  for (let r = 0; r < limit; r += 1) {
    const raw = (matrix[r] ?? []).map((c) => cellText(c));
    if (raw.filter(Boolean).length < 3) continue;
    const headers = raw.map((h, i) => h || `Column ${i + 1}`);
    const fields: Partial<Record<ImportField, string>> = {};
    const used = new Set<ImportField>();
    for (const header of headers) {
      const field = fieldForHeader(header);
      if (!field || used.has(field)) continue;
      // Prefer the first "Tester's Comment" style column when several comment headers exist.
      used.add(field);
      fields[field] = header;
    }
    const score =
      (fields.module || fields.feature ? 3 : 0) +
      (fields.issue ? 3 : 0) +
      (fields.status ? 2 : 0) +
      (fields.retest ? 2 : 0) +
      (fields.platform ? 1 : 0) +
      (fields.sn ? 1 : 0);
    if (score >= 5 && score > bestScore && (fields.module || fields.feature) && (fields.issue || fields.status || fields.retest)) {
      bestScore = score;
      best = { fields, headers, headerRow: r };
    }
  }
  return best;
}

function valueOf(values: Record<string, string>, map: ImportColumnMap, field: ImportField): string {
  const header = map.fields[field];
  return header ? (values[header] ?? "") : "";
}

function buildQuery(row: Omit<ImportSheetRow, "query">): string {
  const parts = [
    row.feature && `Feature: ${row.feature}`,
    row.issue && `Issue: ${row.issue}`,
    row.testerComment && `Tester: ${row.testerComment}`,
    row.retest && `Retest: ${row.retest}`,
    row.platform && `Platform: ${row.platform}`,
  ].filter(Boolean);
  return parts.join("\n").slice(0, MAX_IMPORT_CELL);
}

/**
 * What Spira result a sheet row should become. Retest Result wins over Status. Rows that are still
 * open without a fail, or closed with no retest outcome, return null (nothing to write yet).
 */
export function suggestSheetResult(status: string, retest: string, testerComment = ""): ExecutionStatus | null {
  const r = norm(retest);
  const s = norm(status);
  const notes = norm(`${retest}\n${testerComment}`);

  if (r) {
    // "Pass (Data)", "Pass", "PASSED" — but not "password".
    if (/\bfail(ed|ing|ure)?\b/.test(r)) return "failed";
    if (/\bpass(ed)?\b/.test(r) || /\bpass\s*\(/.test(r)) return "passed";
  }
  if (/\bdefer|descope|out of scope|not in (this )?phase\b/.test(s) || /\bdefer|descope\b/.test(notes)) return "blocked";
  if (/\bclosed\b/.test(s)) {
    if (/\bfail(ed|ing|ure)?\b/.test(notes)) return "failed";
    if (/\bpass(ed)?\b|\bretest\b.*\b(now |populated|displayed|fixed|working|successful)/.test(notes)) return "passed";
    if (/\bretest\b/.test(notes) && !/\bfail|not yet|still|unable|error\b/.test(notes)) return "passed";
    return null;
  }
  if (/\bopen\b/.test(s)) {
    if (/\bfail(ed|ing|ure)?\b/.test(notes)) return "failed";
    return null;
  }
  return null;
}

/** Platform filter from a sheet cell: android / ios / both / unknown. */
export function sheetPlatform(text: string): Platform | "both" | null {
  const t = norm(text);
  if (!t) return null;
  if (/\bboth\b|ios\s*and\s*android|android\s*and\s*ios/.test(t)) return "both";
  if (/\bandroid\b/.test(t)) return "Android";
  if (/\bios\b|iphone|ipad/.test(t)) return "iOS";
  return null;
}

/**
 * Picks the draft modules a sheet Module cell refers to. Soft match on module name; empty module
 * matches every draft (Gemini then narrows by the issue text).
 */
export function matchImportModules(moduleCell: string, modules: string[]): string[] {
  const wanted = norm(moduleCell);
  if (!wanted) return modules;
  const scored = modules
    .map((m) => {
      const n = norm(m);
      let score = wordingSimilarity(wanted, n);
      if (n.includes(wanted) || wanted.includes(n)) score = Math.max(score, 0.85);
      // "Onboarding & identity" ↔ "Onboarding"
      for (const part of wanted.split(/\s+/)) if (part.length >= 4 && n.includes(part)) score = Math.max(score, 0.55);
      return { m, score };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored.map((x) => x.m) : modules;
}

/** Whether a target's test set fits the sheet's platform. */
export function fitsPlatform(testSetName: string, platform: Platform | "both" | null): boolean {
  if (!platform || platform === "both") return true;
  const n = norm(testSetName);
  const android = n.includes("android");
  const ios = n.includes("ios") || n.includes("iphone");
  if (platform === "Android") return android || !ios;
  return ios || !android;
}

/**
 * Turns a sheet matrix into import rows. `map` must come from findImportHeader. Empty issue+feature
 * rows are dropped.
 */
export function parseImportRows(matrix: unknown[][], map: ImportColumnMap, sheetName: string): ImportSheet {
  const rows: ImportSheetRow[] = [];
  let actionable = 0;
  let skipped = 0;
  for (let r = map.headerRow + 1; r < matrix.length && rows.length < MAX_IMPORT_ROWS; r += 1) {
    const raw = matrix[r] ?? [];
    const values: Record<string, string> = {};
    map.headers.forEach((header, col) => {
      values[header] = cellText(raw[col]);
    });
    const base = {
      rowNumber: r + 1,
      sn: valueOf(values, map, "sn"),
      module: valueOf(values, map, "module"),
      feature: valueOf(values, map, "feature"),
      issue: valueOf(values, map, "issue"),
      status: valueOf(values, map, "status"),
      retest: valueOf(values, map, "retest"),
      platform: valueOf(values, map, "platform"),
      severity: valueOf(values, map, "severity"),
      testerComment: valueOf(values, map, "testerComment"),
      devComment: valueOf(values, map, "devComment"),
    };
    if (!base.issue && !base.feature && !base.retest) continue;
    const query = buildQuery(base);
    if (query.trim().length < 8) continue;
    const result = suggestSheetResult(base.status, base.retest, base.testerComment);
    if (result) actionable += 1;
    else skipped += 1;
    rows.push({ ...base, query });
  }
  return { sheetName, map, rows, actionable, skipped };
}
