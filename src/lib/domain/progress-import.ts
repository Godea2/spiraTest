/**
 * Parse and interpret colleague progress / issue sheets and UAT smoke packs for Progress → Spira runs.
 * Stays inside the existing Reports template: this is intake for execution results, not a report format.
 */
import { wordingSimilarity } from "./defects";
import type { ExecutionStatus, Platform } from "./types";

export const MAX_IMPORT_ROWS = 120;
export const MAX_IMPORT_CELL = 4_000;

/** Columns we can recognise. Names are matched loosely (issue logs and smoke packs). */
export type ImportField =
  | "sn"
  | "caseId"
  | "module"
  | "feature"
  | "issue"
  | "caseName"
  | "uatRef"
  | "status"
  | "retest"
  | "iosStatus"
  | "androidStatus"
  | "overallStatus"
  | "platform"
  | "severity"
  | "testerComment"
  | "devComment"
  | "testerName"
  | "expected";

const FIELD_ALIASES: Record<ImportField, string[]> = {
  sn: ["s/n", "sn", "s n", "no", "#", "item"],
  caseId: ["st id", "smk id", "smoke id", "case id", "tc id"],
  module: ["module", "area module", "test module"],
  feature: ["feature / area", "feature/area", "feature / journey", "feature/journey", "feature", "area", "feature area", "journey", "screen"],
  issue: ["issue observed", "issue", "observation", "defect", "bug", "description", "what went wrong"],
  caseName: ["smoke test case", "test case name", "test case", "smoke case", "case name"],
  uatRef: ["uat tc ref", "uat ref", "uat tc", "uat case", "tc ref"],
  status: ["issue status", "current status", "status"],
  retest: ["retest result", "re-test result", "retest", "re-test", "qa result"],
  iosStatus: ["ios status", "ios – status", "ios - status", "i os status", "iphone status"],
  androidStatus: ["android status", "android – status", "android - status"],
  overallStatus: ["overall status", "overall", "combined status"],
  platform: ["platform / device", "platform/device", "platform", "device", "os"],
  severity: ["severity", "sev", "priority"],
  testerComment: ["tester's comment", "testers comment", "tester comment", "qa comment", "retest comment", "comments", "comment"],
  devComment: ["developer's comment", "developers comment", "dev comment", "developing team comment"],
  testerName: ["tester", "tested by", "executed by", "qa tester"],
  expected: ["expected result", "expected"],
};

export type ImportKind = "issues" | "smoke";

export interface ImportColumnMap {
  /** Header text as in the sheet, keyed by the field we use it for. */
  fields: Partial<Record<ImportField, string>>;
  /** Every header on the header row, for the UI. */
  headers: string[];
  headerRow: number;
  /** How strongly this looks like a progress sheet (for picking among workbook tabs). */
  score: number;
  kind: ImportKind;
}

export interface ImportSheetRow {
  /** 1-based sheet row number. */
  rowNumber: number;
  sn: string;
  caseId: string;
  module: string;
  feature: string;
  issue: string;
  caseName: string;
  uatRef: string;
  status: string;
  retest: string;
  iosStatus: string;
  androidStatus: string;
  overallStatus: string;
  platform: string;
  severity: string;
  testerComment: string;
  devComment: string;
  testerName: string;
  expected: string;
  /** Text Gemini and the tester use to find cases. */
  query: string;
}

export interface ImportSheet {
  sheetName: string;
  kind: ImportKind;
  map: ImportColumnMap;
  rows: ImportSheetRow[];
  /** Rows that look like they carry a result we can write to Spira. */
  actionable: number;
  skipped: number;
  /** Tester name most often filled on the sheet, when present. */
  testerName: string | null;
}

/** One Pass/Fail/Blocked outcome taken from a sheet row, optionally for one platform. */
export interface RowOutcome {
  platform: Platform | "both" | null;
  result: ExecutionStatus;
  label: string;
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
      if (h === a) score = 100 + Math.min(a.length, 30);
      else if (h.startsWith(`${a} `) || a.startsWith(`${h} `) || h.startsWith(`${a}/`) || h.startsWith(`${a}(`)) score = 80 + Math.min(a.length, 20);
      else if (` ${h} `.includes(` ${a} `) && a.length >= 4) score = 55 + Math.min(a.length, 20);
      else score = Math.round(wordingSimilarity(h, a) * 40);
      // Prefer specific status columns over bare "status".
      if (field === "status" && (h.includes("ios") || h.includes("android") || h.includes("overall") || h.includes("retest"))) score = 0;
      if (field === "testerName" && h.includes("comment")) score = 0;
      if (field === "caseName" && h.includes("issue")) score = 0;
      if (score >= 55 && (!best || score > best.score)) best = { field, score };
    }
  }
  return best?.field ?? null;
}

function kindFromFields(fields: Partial<Record<ImportField, string>>): ImportKind {
  if (fields.caseName || fields.caseId || fields.iosStatus || fields.androidStatus || fields.overallStatus || fields.uatRef) return "smoke";
  return "issues";
}

function headerScore(fields: Partial<Record<ImportField, string>>): number {
  const kind = kindFromFields(fields);
  if (kind === "smoke") {
    return (
      (fields.module ? 3 : 0) +
      (fields.caseName || fields.issue ? 4 : 0) +
      (fields.caseId ? 2 : 0) +
      (fields.overallStatus ? 3 : 0) +
      (fields.iosStatus ? 2 : 0) +
      (fields.androidStatus ? 2 : 0) +
      (fields.feature ? 1 : 0) +
      (fields.uatRef ? 1 : 0) +
      (fields.testerName ? 1 : 0)
    );
  }
  return (
    (fields.module || fields.feature ? 3 : 0) +
    (fields.issue ? 3 : 0) +
    (fields.status ? 2 : 0) +
    (fields.retest ? 2 : 0) +
    (fields.platform ? 1 : 0) +
    (fields.sn ? 1 : 0)
  );
}

function headerAccepted(fields: Partial<Record<ImportField, string>>, score: number): boolean {
  const kind = kindFromFields(fields);
  if (kind === "smoke") {
    return score >= 7 && !!fields.module && !!(fields.caseName || fields.issue || fields.caseId) && !!(fields.overallStatus || fields.iosStatus || fields.androidStatus || fields.status || fields.retest);
  }
  return score >= 5 && !!(fields.module || fields.feature) && !!(fields.issue || fields.status || fields.retest);
}

/**
 * Finds the header row of a progress / issue or smoke sheet. Looks in the first 30 rows.
 */
export function findImportHeader(matrix: unknown[][]): ImportColumnMap | null {
  const limit = Math.min(matrix.length, 30);
  let best: ImportColumnMap | null = null;
  for (let r = 0; r < limit; r += 1) {
    const raw = (matrix[r] ?? []).map((c) => cellText(c));
    if (raw.filter(Boolean).length < 3) continue;
    const headers = raw.map((h, i) => h || `Column ${i + 1}`);
    const fields: Partial<Record<ImportField, string>> = {};
    const used = new Set<ImportField>();
    for (const header of headers) {
      const field = fieldForHeader(header);
      if (!field || used.has(field)) continue;
      used.add(field);
      fields[field] = header;
    }
    const score = headerScore(fields);
    if (!headerAccepted(fields, score)) continue;
    if (!best || score > best.score) {
      best = { fields, headers, headerRow: r, score, kind: kindFromFields(fields) };
    }
  }
  return best;
}

function valueOf(values: Record<string, string>, map: ImportColumnMap, field: ImportField): string {
  const header = map.fields[field];
  return header ? (values[header] ?? "") : "";
}

function buildQuery(row: Omit<ImportSheetRow, "query">, kind: ImportKind): string {
  if (kind === "smoke") {
    // Match on the columns testers care about for this pack — not the long step text.
    const parts = [
      row.module && `Module: ${row.module}`,
      row.feature && `Feature / Journey: ${row.feature}`,
      row.caseName && `Smoke test case: ${row.caseName}`,
      row.uatRef && `UAT TC: ${row.uatRef}`,
      row.caseId && `ST ID: ${row.caseId}`,
      row.testerComment && `Comment: ${row.testerComment}`,
    ].filter(Boolean);
    return parts.join("\n").slice(0, MAX_IMPORT_CELL);
  }
  const parts = [
    row.feature && `Feature: ${row.feature}`,
    row.issue && `Issue: ${row.issue}`,
    row.testerComment && `Tester: ${row.testerComment}`,
    row.retest && `Retest: ${row.retest}`,
    row.platform && `Platform: ${row.platform}`,
  ].filter(Boolean);
  return parts.join("\n").slice(0, MAX_IMPORT_CELL);
}

/** Pass / Fail / Blocked / Not Run / N/A from a smoke-pack status cell. */
export function parseOutcomeStatus(text: string): ExecutionStatus | null {
  const t = norm(text);
  if (!t) return null;
  if (/\bnot\s*run\b|\bn ?a\b|\bn\/a\b|\bpending\b|\bawaiting\b|\bto confirm\b|\bunder construction\b/.test(t)) return null;
  if (/\bfail(ed|ing|ure)?\b/.test(t)) return "failed";
  if (/\bpass(ed)?\b/.test(t) || /\bpass\s*\(/.test(t)) return "passed";
  if (/\bblock(ed)?\b|\bdefer|\bdescope\b/.test(t)) return "blocked";
  return null;
}

/**
 * What Spira result an issue-log row should become. Retest Result wins over Status. Rows that are still
 * open without a fail, or closed with no retest outcome, return null (nothing to write yet).
 */
export function suggestSheetResult(status: string, retest: string, testerComment = ""): ExecutionStatus | null {
  const r = norm(retest);
  const s = norm(status);
  const notes = norm(`${retest}\n${testerComment}`);

  if (r) {
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
  return parseOutcomeStatus(status);
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
 * Pass/Fail/Blocked outcomes on a row. Smoke packs split iOS and Android when those columns exist;
 * issue logs use Retest / Status and an optional Platform cell.
 */
export function rowOutcomes(row: ImportSheetRow, kind: ImportKind): RowOutcome[] {
  if (kind === "smoke" || row.iosStatus || row.androidStatus || row.overallStatus) {
    const out: RowOutcome[] = [];
    const ios = parseOutcomeStatus(row.iosStatus);
    const android = parseOutcomeStatus(row.androidStatus);
    if (ios) out.push({ platform: "iOS", result: ios, label: "iOS" });
    if (android) out.push({ platform: "Android", result: android, label: "Android" });
    if (out.length) return out;
    const overall = parseOutcomeStatus(row.overallStatus) ?? suggestSheetResult(row.status, row.retest, row.testerComment);
    if (overall) return [{ platform: "both", result: overall, label: "Overall" }];
    return [];
  }
  const result = suggestSheetResult(row.status, row.retest, row.testerComment);
  if (!result) return [];
  return [{ platform: sheetPlatform(row.platform), result, label: row.retest.trim() ? "Retest" : "Status" }];
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

/** One Gemini match considered for default ticks on an import row. */
export interface ImportMatchPick {
  key: string;
  name: string;
  relevance: "high" | "medium" | "low";
}

/**
 * Which matches are ticked before the tester reviews. Issue logs keep high+medium.
 * Smoke packs tick at most one best case (UAT ref / name / high relevance) so a single
 * Fail does not fan out across a whole module in Spira.
 */
export function defaultImportSelection(
  kind: ImportKind,
  row: Pick<ImportSheetRow, "uatRef" | "caseName">,
  matches: ImportMatchPick[],
): Set<string> {
  if (kind !== "smoke") {
    return new Set(matches.filter((m) => m.relevance === "high" || m.relevance === "medium").map((m) => m.key));
  }
  if (matches.length === 0) return new Set();

  const uat = norm(row.uatRef).replace(/\s+/g, "");
  const uatLoose = norm(row.uatRef);
  const caseName = norm(row.caseName);
  const scored = matches
    .map((m) => {
      const n = norm(m.name);
      const compact = n.replace(/\s+/g, "");
      let score = m.relevance === "high" ? 300 : m.relevance === "medium" ? 200 : 50;
      if (uat && (compact.includes(uat) || n.includes(uatLoose))) score += 500;
      if (caseName) score += Math.round(wordingSimilarity(caseName, n) * 120);
      return { key: m.key, score, relevance: m.relevance };
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const best = scored[0];
  // Need a real signal — not a lone low match.
  if (best.relevance === "low" && best.score < 400) return new Set();
  if (best.score < 200) return new Set();
  return new Set([best.key]);
}

/**
 * Turns a sheet matrix into import rows. `map` must come from findImportHeader. Empty issue/case
 * rows are dropped.
 */
export function parseImportRows(matrix: unknown[][], map: ImportColumnMap, sheetName: string): ImportSheet {
  const kind = map.kind;
  const rows: ImportSheetRow[] = [];
  let actionable = 0;
  let skipped = 0;
  const testerCounts = new Map<string, number>();

  for (let r = map.headerRow + 1; r < matrix.length && rows.length < MAX_IMPORT_ROWS; r += 1) {
    const raw = matrix[r] ?? [];
    const values: Record<string, string> = {};
    map.headers.forEach((header, col) => {
      values[header] = cellText(raw[col]);
    });
    const base: Omit<ImportSheetRow, "query"> = {
      rowNumber: r + 1,
      sn: valueOf(values, map, "sn"),
      caseId: valueOf(values, map, "caseId"),
      module: valueOf(values, map, "module"),
      feature: valueOf(values, map, "feature"),
      issue: valueOf(values, map, "issue"),
      caseName: valueOf(values, map, "caseName"),
      uatRef: valueOf(values, map, "uatRef"),
      status: valueOf(values, map, "status"),
      retest: valueOf(values, map, "retest"),
      iosStatus: valueOf(values, map, "iosStatus"),
      androidStatus: valueOf(values, map, "androidStatus"),
      overallStatus: valueOf(values, map, "overallStatus"),
      platform: valueOf(values, map, "platform"),
      severity: valueOf(values, map, "severity"),
      testerComment: valueOf(values, map, "testerComment"),
      devComment: valueOf(values, map, "devComment"),
      testerName: valueOf(values, map, "testerName"),
      expected: valueOf(values, map, "expected"),
    };
    const hasBody =
      kind === "smoke"
        ? !!(base.caseName || base.caseId || base.issue || base.feature)
        : !!(base.issue || base.feature || base.retest);
    if (!hasBody) continue;
    const query = buildQuery(base, kind);
    if (query.trim().length < 8) continue;
    const outcomes = rowOutcomes({ ...base, query }, kind);
    if (outcomes.length) actionable += 1;
    else skipped += 1;
    if (base.testerName) testerCounts.set(base.testerName, (testerCounts.get(base.testerName) ?? 0) + 1);
    rows.push({ ...base, query });
  }

  let testerName: string | null = null;
  let bestCount = 0;
  for (const [name, count] of testerCounts) {
    if (count > bestCount) {
      testerName = name;
      bestCount = count;
    }
  }

  return { sheetName, kind, map, rows, actionable, skipped, testerName };
}
