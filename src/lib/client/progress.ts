import { chunk } from "@/lib/domain/board";
import {
  compareProgress,
  MAX_PROGRESS_CHECKS,
  MAX_PROGRESS_POOL,
  MAX_PROGRESS_SEARCH_CASES,
  MAX_PROGRESS_TEXT,
  mergeProgressCandidates,
  progressTargets,
  rankByWording,
  unreadProgress,
  type ProgressTarget,
} from "@/lib/domain/progress";
import {
  findImportHeader,
  fitsPlatform,
  matchImportModules,
  parseImportRows,
  sheetPlatform,
  suggestSheetResult,
  type ImportSheet,
  type ImportSheetRow,
} from "@/lib/domain/progress-import";
import { currentStatus, MAX_EXECUTION_BATCH } from "@/lib/domain/execution";
import { MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import { readWorkbook } from "@/lib/domain/workbook";
import type { DefectCandidate, Draft, ExecutionResult, ExecutionStatus, ProgressAnalysis } from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api, ApiError, errorMessage } from "./api";
import { getDraft } from "./drafts";
import { recordResults } from "./execution";
import { readItem, writeItem } from "./storage";
import * as XLSX from "xlsx";

export { MAX_PROGRESS_TEXT, progressTargets, suggestSheetResult, type ProgressTarget };
export type { ImportSheet, ImportSheetRow };

const LEFT_OUT_KEY = "progress-left-out";

/** Modules left out of the progress search in this browser. */
export function readLeftOutModules(): string[] {
  const stored = readItem<unknown>(LEFT_OUT_KEY);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

export function storeLeftOutModules(draftIds: string[]): void {
  try {
    writeItem(LEFT_OUT_KEY, draftIds);
  } catch {
    // Only a convenience: the choice still applies to this visit.
  }
}

export type ProgressPhase = { stage: "understanding"; modules: number } | { stage: "reading"; total: number; modules: number; feature: string };

export interface ProgressCase {
  target: ProgressTarget;
  candidate: DefectCandidate;
}

export interface ProgressSearch {
  description: string;
  analysis: ProgressAnalysis;
  searched: number;
  total: number;
  modules: number;
  understood: boolean;
  complete: boolean;
  unreadError: string | null;
  cases: ProgressCase[];
}

const BUSY_RETRY_MS = 4_000;

async function askGemini<T>(path: string, body: unknown): Promise<T> {
  try {
    return await api<T>(path, { method: "POST", body });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
    await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
    return api<T>(path, { method: "POST", body });
  }
}

const understood = new Map<string, Promise<ProgressAnalysis>>();

function understand(description: string, modules: Array<{ module: string; testSets: string[] }>): Promise<ProgressAnalysis> {
  const key = JSON.stringify([description.trim().toLowerCase(), modules]);
  const known = understood.get(key);
  if (known) return known;
  const request = askGemini<ProgressAnalysis>("/api/ai/progress/understand", { description, modules });
  understood.set(key, request);
  request.catch(() => understood.delete(key));
  return request;
}

async function inPool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index]);
      }
    }),
  );
  return out;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Finds the cases that cover work the tester already did, across the given drafts (Completed preferred).
 * Gemini works out the feature, then picks cases about it from their names. No step check: the tester
 * confirms which to mark Passed. Read-only.
 */
export async function searchProgress(drafts: Draft[], description: string, onPhase: (phase: ProgressPhase) => void = () => {}): Promise<ProgressSearch> {
  if (drafts.length === 0) throw new Error("Choose at least one module to search.");
  const projectId = drafts[0].projectId;
  if (drafts.some((d) => d.projectId !== projectId)) throw new Error("Search the modules of one Spira project at a time.");
  const targets = progressTargets(drafts);
  if (targets.length === 0) throw new Error("The chosen modules have no In Scope cases left to mark.");
  const modules = new Set(targets.map((t) => t.module)).size;

  onPhase({ stage: "understanding", modules });
  const outline = new Map<string, Set<string>>();
  for (const t of targets) outline.set(t.module, (outline.get(t.module) ?? new Set()).add(t.testSetName));
  let analysis: ProgressAnalysis;
  try {
    analysis = await understand(
      description,
      [...outline].map(([module, sets]) => ({ module, testSets: [...sets].slice(0, 12) })),
    );
  } catch (err) {
    return {
      description,
      analysis: unreadProgress(description),
      searched: 0,
      total: targets.length,
      modules,
      understood: false,
      complete: false,
      unreadError: `Working out the feature: ${errorMessage(err)}`,
      cases: [],
    };
  }
  const reading = { feature: analysis.feature, related: analysis.related, area: analysis.area, summary: analysis.summary };

  const entries = rankByWording(
    [description, analysis.feature, analysis.area, ...analysis.related].join(" "),
    targets.map((target) => ({ key: target.card.key, text: `${target.card.name} ${target.card.workbookScenario ?? ""}`, target })),
    MAX_PROGRESS_POOL,
  );
  onPhase({ stage: "reading", total: entries.length, modules, feature: analysis.feature || analysis.area });
  const parts = await inPool(chunk(entries, MAX_PROGRESS_SEARCH_CASES), 2, async (part) => {
    try {
      const out = await askGemini<{ candidates: DefectCandidate[] }>("/api/ai/progress/search", {
        description,
        analysis: reading,
        cases: part.map(({ target }) => ({
          key: target.card.key,
          module: target.module,
          testSetName: target.testSetName,
          scenario: clip(target.card.name, MAX_SCENARIO_TEXT),
          ...(target.card.workbookScenario ? { workbookScenario: clip(target.card.workbookScenario, MAX_SCENARIO_TEXT) } : {}),
        })),
      });
      return { size: part.length, candidates: out.candidates, error: null as unknown };
    } catch (error) {
      return { size: part.length, candidates: null, error };
    }
  });
  const answered = parts.flatMap((p) => (p.candidates ? [p.candidates] : []));
  const searched = parts.reduce((n, p) => n + (p.candidates ? p.size : 0), 0);
  const failedPart = parts.find((p) => !p.candidates);
  const unreadError = !failedPart
    ? null
    : answered.length === 0
      ? `Matching cases to "${analysis.feature || analysis.area}": ${errorMessage(failedPart.error)}`
      : errorMessage(failedPart.error);
  const candidates = mergeProgressCandidates(answered, MAX_PROGRESS_CHECKS);
  const byKey = new Map(entries.map((e) => [e.key, e.target]));
  const cases = candidates
    .flatMap((candidate) => {
      const target = byKey.get(candidate.key);
      return target ? [{ target, candidate }] : [];
    })
    .sort((a, b) => compareProgress(a.candidate.relevance, b.candidate.relevance) || a.target.module.localeCompare(b.target.module) || a.target.card.name.localeCompare(b.target.card.name));
  return { description, analysis, searched, total: entries.length, modules, understood: true, complete: !failedPart, unreadError, cases };
}

export interface ProgressPick {
  target: ProgressTarget;
  status: ExecutionStatus;
  comment: string;
}

export interface PassProgressOutcome {
  results: ExecutionResult[];
  failed: Array<{ target: ProgressTarget; message: string; status?: ExecutionStatus }>;
  recorded: number;
}

/**
 * Records results in Spira for every pick, across modules, in batches per test set. A case already
 * showing the same result is skipped unless force is set. A write: not retried.
 */
export async function recordProgress(
  picks: ProgressPick[],
  tester: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean; force?: boolean } = {},
): Promise<PassProgressOutcome> {
  const failed: PassProgressOutcome["failed"] = [];
  const results: ExecutionResult[] = [];
  const ready = picks.filter((pick) => {
    try {
      const draft = getDraft(pick.target.draftId);
      const status = currentStatus(pick.target.card, draft.execution);
      if (status === pick.status && !options.force) {
        failed.push({
          target: pick.target,
          status: pick.status,
          message: `Already ${pick.status === "passed" ? "Passed" : pick.status === "failed" ? "Failed" : pick.status} in Spira; leave it, or tick Force to record a newer run.`,
        });
        return false;
      }
      return true;
    } catch (err) {
      failed.push({ target: pick.target, status: pick.status, message: errorMessage(err) });
      return false;
    }
  });
  const byDraft = new Map<string, ProgressPick[]>();
  for (const p of ready) byDraft.set(p.target.draftId, [...(byDraft.get(p.target.draftId) ?? []), p]);
  let done = 0;

  for (const [draftId, group] of byDraft) {
    if (options.keepGoing && !options.keepGoing()) break;
    const bySet = new Map<number, ProgressPick[]>();
    for (const p of group) bySet.set(p.target.card.testSetId, [...(bySet.get(p.target.card.testSetId) ?? []), p]);
    for (const [testSetId, setPicks] of bySet) {
      if (options.keepGoing && !options.keepGoing()) break;
      const before = done;
      try {
        const out = await recordResults(
          draftId,
          testSetId,
          setPicks.map((p) => ({
            testCaseId: p.target.card.testCaseId,
            testSetTestCaseId: p.target.card.testSetTestCaseId,
            status: p.status,
            comment: p.comment.trim(),
            steps: [],
          })),
          tester,
          { keepGoing: options.keepGoing, onBatch: (n) => options.onProgress?.(before + n, ready.length) },
        );
        results.push(...out.results);
        for (const r of out.results) {
          const p = setPicks.find((x) => x.target.card.testSetTestCaseId === r.testSetTestCaseId);
          if (!p) continue;
          if (r.result !== "recorded") failed.push({ target: p.target, status: p.status, message: r.message ?? r.result });
        }
      } catch (err) {
        for (const p of setPicks) failed.push({ target: p.target, status: p.status, message: errorMessage(err) });
      }
      done = before + setPicks.length;
      options.onProgress?.(done, ready.length);
    }
  }
  for (const p of ready) {
    if (
      !results.some((r) => r.testSetTestCaseId === p.target.card.testSetTestCaseId && r.testSetId === p.target.card.testSetId) &&
      !failed.some((f) => f.target === p.target)
    ) {
      failed.push({ target: p.target, status: p.status, message: "Stopped before it was recorded." });
    }
  }
  const recorded = results.filter((r) => r.result === "recorded").length;
  if (recorded > 0) {
    const modules = [...new Set(ready.map((p) => p.target.module))];
    const byStatus = new Map<string, number>();
    for (const r of results) if (r.result === "recorded") byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    const summary = [...byStatus].map(([s, n]) => `${n} ${s}`).join(", ");
    logActivity({
      type: "progress.recorded",
      message: `Recorded ${recorded} run(s) from progress (${summary}) in ${modules.join(", ")}.`,
      module: modules.length === 1 ? modules[0] : null,
      details: { recorded, failed: failed.length, byStatus: Object.fromEntries(byStatus), batch: MAX_EXECUTION_BATCH },
    });
  }
  return { results, failed, recorded };
}

/** Records Passed runs (the Describe flow). */
export async function passProgress(
  picks: ProgressTarget[],
  tester: string,
  comment: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean; force?: boolean } = {},
): Promise<PassProgressOutcome> {
  return recordProgress(
    picks.map((target) => ({ target, status: "passed", comment })),
    tester,
    options,
  );
}

/** Reads a colleague's .xlsx / .xls / .csv progress sheet and finds Module / Issue / Status / Retest columns. */
export async function parseProgressSheet(file: File): Promise<ImportSheet> {
  if (!/\.(xlsx|xlsm|xls|csv)$/i.test(file.name)) throw new Error("Choose an Excel workbook or CSV (.xlsx, .xlsm, .xls or .csv).");
  const workbook = /\.csv$/i.test(file.name) ? XLSX.read(await file.text(), { type: "string", raw: true }) : readWorkbook(await file.arrayBuffer());
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("This file has no sheets.");
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: true, raw: true });
  const map = findImportHeader(matrix);
  if (!map) {
    throw new Error(
      'Could not find a header row with Module (or Feature) and Issue, Status or Retest Result. Check the first sheet looks like a progress / issue log.',
    );
  }
  const parsed = parseImportRows(matrix, map, sheetName);
  if (parsed.rows.length === 0) throw new Error("No issue rows were found under that header.");
  return parsed;
}

export interface MappedImportRow {
  row: ImportSheetRow;
  /** null when the sheet has nothing to write for this row yet (still Open, closed without retest, …). */
  result: ExecutionStatus | null;
  reason: string;
  matches: ProgressCase[];
  /** Case keys ticked for recording. */
  selected: Set<string>;
  error: string | null;
}

export type ImportMapPhase = { done: number; total: number; label: string };

/**
 * For each actionable sheet row, asks Gemini for the related In Scope cases in the matching modules
 * (and platform). Rows with no result yet are kept for review but not matched. Read-only.
 */
export async function mapProgressSheet(
  sheet: ImportSheet,
  drafts: Draft[],
  onPhase?: (phase: ImportMapPhase) => void,
): Promise<MappedImportRow[]> {
  const modules = [...new Set(drafts.map((d) => d.module))];
  const allTargets = progressTargets(drafts);
  const actionable = sheet.rows.filter((row) => suggestSheetResult(row.status, row.retest, row.testerComment));
  const out: MappedImportRow[] = [];
  let done = 0;

  for (const row of sheet.rows) {
    const result = suggestSheetResult(row.status, row.retest, row.testerComment);
    const platform = sheetPlatform(row.platform);
    const moduleNames = matchImportModules(row.module, modules);
    const scopedDrafts = drafts.filter((d) => moduleNames.includes(d.module));
    const reason = !result
      ? row.status.trim()
        ? `Sheet status "${row.status}"${row.retest ? ` / retest "${clip(row.retest, 40)}"` : ""} — nothing to write in Spira yet.`
        : "No Status or Retest Result that maps to Passed, Failed or Blocked."
      : `Record as ${result === "passed" ? "Passed" : result === "failed" ? "Failed" : "Blocked"} from ${row.retest.trim() ? "Retest Result" : "Status"}.`;

    if (!result) {
      out.push({ row, result, reason, matches: [], selected: new Set(), error: null });
      continue;
    }
    if (scopedDrafts.length === 0 || allTargets.length === 0) {
      out.push({ row, result, reason, matches: [], selected: new Set(), error: "No In Scope cases in the modules this row names." });
      continue;
    }

    onPhase?.({ done, total: actionable.length, label: clip(row.feature || row.issue, 60) });
    try {
      // Prefer cases in the row's module and platform; searchProgress still understands the feature.
      const filtered = scopedDrafts.map((d) => ({
        ...d,
        testSets: d.testSets.filter((s) => fitsPlatform(s.testSetName, platform)),
      })).filter((d) => d.testSets.length > 0);
      const searchDrafts = filtered.length ? filtered : scopedDrafts;
      const search = await searchProgress(searchDrafts, row.query, () => {});
      const matches = search.cases.filter((c) => fitsPlatform(c.target.testSetName, platform));
      const selected = new Set(
        matches.filter((c) => c.candidate.relevance === "high" || c.candidate.relevance === "medium").map((c) => `${c.target.draftId}|${c.target.card.key}`),
      );
      out.push({ row, result, reason, matches, selected, error: search.unreadError });
    } catch (err) {
      out.push({ row, result, reason, matches: [], selected: new Set(), error: errorMessage(err) });
    }
    done += 1;
    onPhase?.({ done, total: actionable.length, label: clip(row.feature || row.issue, 60) });
  }
  return out;
}

/** Builds the Spira picks from a reviewed import mapping. */
export function picksFromImport(mapped: MappedImportRow[]): ProgressPick[] {
  const picks: ProgressPick[] = [];
  const seen = new Set<string>();
  for (const m of mapped) {
    if (!m.result) continue;
    const comment = clip(
      [m.row.feature && `[${m.row.feature}]`, m.row.issue, m.row.retest && `Retest: ${m.row.retest}`].filter(Boolean).join("\n"),
      1_500,
    );
    for (const c of m.matches) {
      const key = `${c.target.draftId}|${c.target.card.key}`;
      if (!m.selected.has(key) || seen.has(key)) continue;
      seen.add(key);
      picks.push({ target: c.target, status: m.result, comment });
    }
  }
  return picks;
}
