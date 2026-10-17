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
import { currentStatus, MAX_EXECUTION_BATCH } from "@/lib/domain/execution";
import { MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import type { DefectCandidate, Draft, ExecutionResult, ProgressAnalysis } from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api, ApiError, errorMessage } from "./api";
import { getDraft } from "./drafts";
import { recordResults } from "./execution";
import { readItem, writeItem } from "./storage";

export { MAX_PROGRESS_TEXT, progressTargets, type ProgressTarget };

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

export interface PassProgressOutcome {
  results: ExecutionResult[];
  failed: Array<{ target: ProgressTarget; message: string }>;
  recorded: number;
}

/**
 * Records Passed in Spira for every picked case, across modules, in batches per test set. Cases already
 * Passed stay listed as failed-to-record with a clear message unless force is set. A write: not retried.
 */
export async function passProgress(
  picks: ProgressTarget[],
  tester: string,
  comment: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean; force?: boolean } = {},
): Promise<PassProgressOutcome> {
  const failed: PassProgressOutcome["failed"] = [];
  const results: ExecutionResult[] = [];
  const ready = picks.filter((target) => {
    try {
      const draft = getDraft(target.draftId);
      const status = currentStatus(target.card, draft.execution);
      if (status === "passed" && !options.force) {
        failed.push({ target, message: "Already Passed in Spira; leave it, or tick Force to record a newer Passed run." });
        return false;
      }
      return true;
    } catch (err) {
      failed.push({ target, message: errorMessage(err) });
      return false;
    }
  });
  const byDraft = new Map<string, ProgressTarget[]>();
  for (const p of ready) byDraft.set(p.draftId, [...(byDraft.get(p.draftId) ?? []), p]);
  let done = 0;
  const note = comment.trim();

  for (const [draftId, group] of byDraft) {
    if (options.keepGoing && !options.keepGoing()) break;
    const bySet = new Map<number, ProgressTarget[]>();
    for (const p of group) bySet.set(p.card.testSetId, [...(bySet.get(p.card.testSetId) ?? []), p]);
    for (const [testSetId, setPicks] of bySet) {
      if (options.keepGoing && !options.keepGoing()) break;
      const before = done;
      try {
        const out = await recordResults(
          draftId,
          testSetId,
          setPicks.map((p) => ({
            testCaseId: p.card.testCaseId,
            testSetTestCaseId: p.card.testSetTestCaseId,
            status: "passed" as const,
            comment: note,
            steps: [],
          })),
          tester,
          { keepGoing: options.keepGoing, onBatch: (n) => options.onProgress?.(before + n, ready.length) },
        );
        results.push(...out.results);
        for (const r of out.results) {
          const p = setPicks.find((x) => x.card.testSetTestCaseId === r.testSetTestCaseId);
          if (!p) continue;
          if (r.result !== "recorded") failed.push({ target: p, message: r.message ?? r.result });
        }
      } catch (err) {
        for (const p of setPicks) failed.push({ target: p, message: errorMessage(err) });
      }
      done = before + setPicks.length;
      options.onProgress?.(done, ready.length);
    }
  }
  for (const p of ready) {
    if (!results.some((r) => r.testSetTestCaseId === p.card.testSetTestCaseId && r.testSetId === p.card.testSetId) && !failed.some((f) => f.target === p)) {
      failed.push({ target: p, message: "Stopped before it was recorded." });
    }
  }
  const recorded = results.filter((r) => r.result === "recorded").length;
  if (recorded > 0) {
    const modules = [...new Set(ready.map((p) => p.module))];
    logActivity({
      type: "progress.passed",
      message: `Recorded ${recorded} Passed run(s) in ${modules.join(", ")}${note ? ` (${clip(note, 80)})` : ""}.`,
      module: modules.length === 1 ? modules[0] : null,
      details: { recorded, failed: failed.length, comment: note, batch: MAX_EXECUTION_BATCH },
    });
  }
  return { results, failed, recorded };
}
