import { cardKey } from "./board";
import type { Card, Column, MissingRow, WorkbookRow } from "./types";

const normalizeHeader = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

/** A test set membership as read from Spira, reduced to what matching needs. */
export interface SetCase {
  testSetTestCaseId: number;
  testCaseId: number;
  name: string;
  executionStatus: string;
  executed: boolean;
  /** Custom property text values; a TC ID stored there counts as a match. */
  customText: string[];
}

export interface ReconcileOutput {
  cards: Card[];
  missingFromSpira: MissingRow[];
  membership: number[];
}

/** Word-overlap score at which an unmatched case is flagged as a possible match. */
export const NEAR_MATCH_THRESHOLD = 0.8;

interface ScopeRow {
  row: WorkbookRow;
  tcId: string;
  scenario: string;
  normalizedScenario: string;
  tokens: Set<string>;
  idPattern: RegExp | null;
}

function cell(row: WorkbookRow, header: string): string {
  const key = Object.keys(row.values).find((k) => normalizeHeader(k) === header);
  const value = key ? row.values[key] : null;
  return value === null || value === undefined ? "" : String(value).trim();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "TC-ONB-001" also matches "TC ONB 001" or "tc_onb_001", but not "TC-ONB-0010". */
function idPatternFor(tcId: string): RegExp | null {
  const parts = tcId.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return null;
  return new RegExp(`(?<![A-Za-z0-9])${parts.map(escapeRegExp).join("[\\s_-]*")}(?![A-Za-z0-9])`, "i");
}

/** Lowercase words only, so punctuation and spacing differences do not matter. */
export function normalizeScenario(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((word) => word.length > 1));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function prepareRows(rows: WorkbookRow[]): ScopeRow[] {
  return rows
    .map((row) => {
      const tcId = cell(row, "tc id");
      const scenario = cell(row, "test scenario");
      const normalizedScenario = normalizeScenario(scenario);
      return { row, tcId, scenario, normalizedScenario, tokens: tokensOf(normalizedScenario), idPattern: idPatternFor(tcId) };
    })
    .filter((r) => r.tcId || r.normalizedScenario);
}

const rowLabel = (r: ScopeRow) => r.tcId || `${r.row.sheet} row ${r.row.rowNumber}`;

function decide(matched: ScopeRow[], how: string): { suggestion: Column; reason: string; tcId: string | null } {
  const ids = [...new Set(matched.map(rowLabel))];
  if (ids.length > 1) {
    return { suggestion: "needsReview", reason: `Matches more than one workbook row (${ids.join(", ")}). Check which one applies.`, tcId: null };
  }
  const scopes = new Set(matched.map((r) => r.row.scope));
  const first = matched[0];
  const where = `${first.row.sheet} row ${first.row.rowNumber}`;
  const tcId = first.tcId || null;
  if (scopes.size > 1) {
    return { suggestion: "needsReview", reason: `${ids[0]} is listed on both the In-Scope and Needs Confirmation sheets.`, tcId };
  }
  if (first.row.scope === "needsConfirmation") {
    return { suggestion: "needsReview", reason: `${ids[0]} is on the Needs Confirmation sheet (${where}).`, tcId };
  }
  return { suggestion: "inScope", reason: `Matched ${ids[0]} by ${how} (${where}).`, tcId };
}

/**
 * Suggests a column for every membership of a test set:
 * 1. A workbook TC ID found in the test case name or a custom property is a match.
 * 2. Otherwise the test case name must equal the workbook Test Scenario (ignoring case and punctuation).
 * 3. Unmatched cases that closely resemble a scenario go to Needs Review rather than Out of Scope.
 * Workbook rows that no membership matched are reported as missing from Spira.
 */
export function reconcileTestSet(testSetId: number, rows: WorkbookRow[], cases: SetCase[]): ReconcileOutput {
  const scopeRows = prepareRows(rows);
  const byScenario = new Map<string, ScopeRow[]>();
  for (const r of scopeRows) {
    if (!r.normalizedScenario) continue;
    byScenario.set(r.normalizedScenario, [...(byScenario.get(r.normalizedScenario) ?? []), r]);
  }
  const matchedRows = new Set<ScopeRow>();

  const cards: Card[] = cases.map((c) => {
    const searchable = [c.name, ...c.customText];
    const byId = scopeRows.filter((r) => r.idPattern && searchable.some((text) => r.idPattern!.test(text)));
    const normalizedName = normalizeScenario(c.name);
    const byName = byId.length ? [] : (byScenario.get(normalizedName) ?? []);
    const matched = byId.length ? byId : byName;
    matched.forEach((r) => matchedRows.add(r));

    let outcome: { suggestion: Column; reason: string; tcId: string | null };
    if (matched.length > 0) {
      outcome = decide(matched, byId.length ? "TC ID" : "test scenario");
    } else {
      const nameTokens = tokensOf(normalizedName);
      let best: { row: ScopeRow; score: number } | null = null;
      for (const r of scopeRows) {
        const score = overlap(nameTokens, r.tokens);
        if (!best || score > best.score) best = { row: r, score };
      }
      outcome =
        best && best.score >= NEAR_MATCH_THRESHOLD
          ? {
              suggestion: "needsReview",
              reason: `Not an exact match, but close to ${rowLabel(best.row)} ("${best.row.scenario}"). Check the wording.`,
              tcId: best.row.tcId || null,
            }
          : { suggestion: "outOfScope", reason: "Not found in the workbook for this module.", tcId: null };
    }

    return {
      key: cardKey(testSetId, c.testSetTestCaseId),
      testSetId,
      testCaseId: c.testCaseId,
      testSetTestCaseId: c.testSetTestCaseId,
      name: c.name,
      tcId: outcome.tcId,
      executionStatus: c.executionStatus,
      executed: c.executed,
      suggestion: outcome.suggestion,
      reason: outcome.reason,
    };
  });

  const missingFromSpira: MissingRow[] = scopeRows
    .filter((r) => !matchedRows.has(r))
    .map((r) => ({
      tcId: r.tcId || `${r.row.sheet} row ${r.row.rowNumber}`,
      testScenario: r.scenario,
      reason: "No test case in this test set has this TC ID or test scenario.",
    }));

  return {
    cards,
    missingFromSpira,
    membership: cases.map((c) => c.testSetTestCaseId).sort((a, b) => a - b),
  };
}
