import { chunk, draftPlatforms, MAX_APPLY_BATCH } from "@/lib/domain/board";
import { recordMoves } from "@/lib/domain/draft-ops";
import {
  copyInput,
  counterpartSets,
  defectsFor,
  MAX_RUN_DETAILS,
  planMirror,
  planResults,
  pushTarget,
  type MirrorPlan,
  type ResultCopy,
  type ResultPlan,
} from "@/lib/domain/mirror";
import { MAX_REPORT_LINKS } from "@/lib/domain/report";
import type {
  AddedCaseResult,
  Draft,
  ExecutionCaseInput,
  ExecutionResult,
  ExecutionStatus,
  MirrorPair,
  Platform,
  ReportIncident,
  RunDetail,
  SpiraTestSetSummary,
} from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api } from "./api";
import { listDefects } from "./defects";
import { allDrafts, createDraft, DraftNotFoundError, getDraft, mutateDraft } from "./drafts";
import { recordResults, refreshExecution } from "./execution";
import { compareTestSet, contextOf } from "./workflow";

// Pushing a completed draft to the other platform: a second draft on the other platform's test sets
// whose board copies the first one, applied through the usual review, and then the first one's results.

/** The newest draft copying this one, if any. */
export function findMirror(sourceId: string): Draft | null {
  return allDrafts().find((d) => d.mirror?.sourceDraftId === sourceId) ?? null;
}

export function mirrorDirection(source: Draft): { from: Platform; to: Platform } | null {
  const platforms = draftPlatforms(source);
  const to = pushTarget(platforms);
  return to ? { from: platforms[0], to } : null;
}

export interface CounterpartOptions {
  /** Every test set of the other platform, for a manual pick. */
  all: SpiraTestSetSummary[];
  /** Best matches per source test set, best first. */
  suggested: Record<number, SpiraTestSetSummary[]>;
}

/** The other platform's test sets in Spira, and the likely counterpart of each of the source's test sets. Read-only. */
export async function findCounterparts(source: Draft, to: Platform): Promise<CounterpartOptions> {
  const { testSets } = await api<{ testSets: SpiraTestSetSummary[] }>("/api/spira/test-sets", {
    method: "POST",
    body: { projectId: source.projectId, releaseId: null },
  });
  const suggested: Record<number, SpiraTestSetSummary[]> = {};
  for (const set of source.testSets) suggested[set.testSetId] = counterpartSets(testSets, set, source.module, to);
  const picked = new Set(source.testSetIds);
  const all = testSets
    .filter((t) => !picked.has(t.testSetId))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || b.testSetId - a.testSetId);
  return { all, suggested };
}

/**
 * Creates the draft for the other platform's test sets, compares them with the same workbook rows
 * (read-only), and puts every card where the source board has it.
 */
export async function startMirror(source: Draft, targets: Array<{ sourceTestSetId: number; target: SpiraTestSetSummary }>, direction: { from: Platform; to: Platform }): Promise<Draft> {
  const draft = createDraft({
    name: `${source.module} · ${direction.to} (from ${direction.from})`,
    module: source.module,
    projectId: source.projectId,
    releaseId: source.releaseId,
    releaseLabel: source.releaseLabel,
    source: source.source,
    rows: source.rows,
    testSetIds: targets.map((t) => t.target.testSetId),
    testSetRefs: targets.map((t) => ({ testSetId: t.target.testSetId, testSetName: t.target.name, platform: direction.to })),
    mirror: {
      sourceDraftId: source.id,
      sourceName: source.name,
      fromPlatform: direction.from,
      toPlatform: direction.to,
      pairs: targets.map((t) => ({ sourceTestSetId: t.sourceTestSetId, targetTestSetId: t.target.testSetId })),
    },
  });
  for (const t of targets) await compareTestSet(draft.id, t.target.testSetId, []);
  logActivity({
    type: "mirror.started",
    message: `Started pushing "${source.name}" to ${direction.to}: ${targets.map((t) => t.target.name).join(", ")}.`,
    draftId: draft.id,
    module: source.module,
    details: { sourceDraftId: source.id, pairs: draft.mirror!.pairs },
  });
  return matchSourceBoard(draft.id).draft;
}

function mirrorOf(draft: Draft): { source: Draft; pairs: MirrorPair[] } {
  if (!draft.mirror) throw new Error("This draft does not copy another draft.");
  return { source: getDraft(draft.mirror.sourceDraftId), pairs: draft.mirror.pairs };
}

/** The plan for a copying draft against its source as both are now; null when it is not a copy or the source is gone. */
export function currentPlan(target: Draft): MirrorPlan | null {
  if (!target.mirror) return null;
  try {
    const { source, pairs } = mirrorOf(target);
    return planMirror(source, target, pairs);
  } catch (error) {
    if (error instanceof DraftNotFoundError) return null;
    throw error;
  }
}

/** Puts every card of the copy where the source board has it (a board edit, nothing in Spira). */
export function matchSourceBoard(targetId: string): { draft: Draft; plan: MirrorPlan; moved: number } {
  const target = getDraft(targetId);
  const { source, pairs } = mirrorOf(target);
  const plan = planMirror(source, target, pairs);
  let moved = 0;
  const draft = mutateDraft(targetId, (d) => {
    moved = recordMoves(d, plan.moves, `Matched to ${source.name}`, new Date().toISOString()).length;
  });
  return { draft, plan, moved };
}

export interface AddReport {
  results: Array<AddedCaseResult & { testSetId: number; name: string }>;
  errors: string[];
}

/**
 * Adds the cases the source keeps and the copy lacks, a batch at a time, then compares each changed
 * test set again so its new memberships come from Spira, and matches the board once more.
 */
export async function addMissingCases(
  targetId: string,
  options: { onBatch?: (done: number) => void; keepGoing?: () => boolean } = {},
): Promise<AddReport> {
  const target = getDraft(targetId);
  const { source } = mirrorOf(target);
  const plan = planMirror(source, target, target.mirror!.pairs);
  const report: AddReport = { results: [], errors: [] };
  for (const set of plan.sets) {
    const names = new Map(set.add.map((a) => [a.testCaseId, a.name]));
    const ids = [...new Set(set.add.map((a) => a.testCaseId))];
    let changed = false;
    for (const batch of chunk(ids, MAX_APPLY_BATCH)) {
      if (options.keepGoing && !options.keepGoing()) break;
      const current = getDraft(targetId);
      try {
        const { results } = await api<{ results: AddedCaseResult[] }>("/api/workflow/add-cases", {
          method: "POST",
          body: {
            target: { context: contextOf(current), testSets: current.testSets },
            source: { context: contextOf(source), testSets: source.testSets, decisions: source.decisions },
            testSetId: set.pair.targetTestSetId,
            sourceTestSetId: set.pair.sourceTestSetId,
            testCaseIds: batch,
          },
        });
        for (const r of results) report.results.push({ ...r, testSetId: set.pair.targetTestSetId, name: names.get(r.testCaseId) ?? `TC${r.testCaseId}` });
        changed ||= results.some((r) => r.result !== "failed");
      } catch (error) {
        report.errors.push(error instanceof Error ? error.message : "Adding the test cases failed.");
        break;
      } finally {
        options.onBatch?.(report.results.length);
      }
    }
    if (changed) {
      try {
        await compareTestSet(targetId, set.pair.targetTestSetId, []);
      } catch (error) {
        report.errors.push(`Compare again: ${error instanceof Error ? error.message : "failed"}`);
      }
    }
  }
  matchSourceBoard(targetId);
  const added = report.results.filter((r) => r.result === "added");
  logActivity({
    type: report.errors.length || report.results.some((r) => r.result === "failed") ? "mirror.addedWithErrors" : "mirror.added",
    message: `Added ${added.length} test case(s) from ${source.name} to the ${target.mirror!.toPlatform} test sets.`,
    draftId: targetId,
    module: target.module,
    details: { added: added.map((r) => ({ testSetId: r.testSetId, testCaseId: r.testCaseId, testSetTestCaseId: r.testSetTestCaseId })) },
  });
  return report;
}

/** Reads both drafts' results from Spira again (read-only) and works out which results to copy. */
export async function planCopy(targetId: string): Promise<{ plan: ResultPlan; source: Draft; target: Draft; errors: string[] }> {
  const { source: before } = mirrorOf(getDraft(targetId));
  const [from, to] = await Promise.all([refreshExecution(before.id), refreshExecution(targetId)]);
  return { plan: planResults(from.draft, to.draft, to.draft.mirror!.pairs), source: from.draft, target: to.draft, errors: [...from.errors, ...to.errors] };
}

/** Incidents behind each non-passed source case: those logged here first, otherwise the open ones Spira links to it. */
async function incidentsFor(source: Draft, copies: ResultCopy[]): Promise<Map<string, number[]>> {
  const records = listDefects(source.projectId);
  const found = new Map<string, number[]>();
  const unknown: ResultCopy[] = [];
  for (const copy of copies) {
    if (copy.status === "passed") continue;
    const ids = defectsFor(records, source.id, copy.source);
    if (ids.length) found.set(copy.card.key, ids);
    else unknown.push(copy);
  }
  for (const batch of chunk([...new Set(unknown.map((c) => c.source.testCaseId))], MAX_REPORT_LINKS)) {
    try {
      const { links, incidents } = await api<{ links: Record<string, number[]>; incidents: ReportIncident[] }>("/api/reports/links", {
        method: "POST",
        body: { projectId: source.projectId, testCaseIds: batch },
      });
      const open = new Set(incidents.filter((i) => i.open).map((i) => i.incidentId));
      for (const copy of unknown) {
        const ids = (links[String(copy.source.testCaseId)] ?? []).filter((id) => open.has(id)).sort((a, b) => a - b);
        if (ids.length) found.set(copy.card.key, ids);
      }
    } catch {
      // The defect reference is a courtesy in the comment; the result is copied either way.
    }
  }
  return found;
}

async function runDetails(projectId: number, copies: ResultCopy[]): Promise<Map<number, RunDetail>> {
  const ids = [...new Set(copies.flatMap((c) => (c.run && c.status !== "passed" ? [c.run.testRunId] : [])))];
  const details = new Map<number, RunDetail>();
  for (const batch of chunk(ids, MAX_RUN_DETAILS)) {
    try {
      const { runs } = await api<{ runs: RunDetail[] }>("/api/execution/runs", { method: "POST", body: { projectId, testRunIds: batch } });
      for (const run of runs) details.set(run.testRunId, run);
    } catch {
      // Without the steps the result is copied with its status and comment only.
    }
  }
  return details;
}

export interface CopyReport {
  results: ExecutionResult[];
  failed: Array<{ key: string; testCaseId: number; message: string }>;
  stopped: boolean;
}

/**
 * Records each planned result on the copy's test sets: step by step from the source's run where the
 * app recorded one (failed, blocked and caution steps with their actual results), otherwise the result
 * alone, always with a comment naming the source and its defects. `stepByStep: false` sends results
 * alone, for a retry.
 */
export async function copyResults(
  targetId: string,
  copies: ResultCopy[],
  tester: string,
  options: { stepByStep?: boolean; onBatch?: (done: number, draft: Draft) => void; keepGoing?: () => boolean } = {},
): Promise<CopyReport> {
  const target = getDraft(targetId);
  const { source } = mirrorOf(target);
  const from = target.mirror!.fromPlatform;
  const stepByStep = options.stepByStep ?? true;
  const [incidents, details] = await Promise.all([incidentsFor(source, copies), stepByStep ? runDetails(source.projectId, copies) : new Map<number, RunDetail>()]);
  const report: CopyReport = { results: [], failed: [], stopped: false };
  const bySet = new Map<number, Array<{ copy: ResultCopy; input: ExecutionCaseInput }>>();
  for (const copy of copies) {
    const input = copyInput(copy, from, incidents.get(copy.card.key) ?? [], copy.run ? details.get(copy.run.testRunId) : undefined);
    bySet.set(copy.card.testSetId, [...(bySet.get(copy.card.testSetId) ?? []), { copy, input }]);
  }
  for (const [testSetId, group] of bySet) {
    if (options.keepGoing && !options.keepGoing()) {
      report.stopped = true;
      break;
    }
    const before = report.results.length;
    try {
      const out = await recordResults(targetId, testSetId, group.map((g) => g.input), tester, {
        keepGoing: options.keepGoing,
        onBatch: (done, d) => options.onBatch?.(before + done, d),
      });
      report.results.push(...out.results);
      if (out.results.length < group.length) report.stopped = true;
    } catch (error) {
      const sent = new Set(report.results.map((r) => `${r.testSetId}:${r.testSetTestCaseId}`));
      for (const { copy } of group) {
        if (!sent.has(copy.card.key)) report.failed.push({ key: copy.card.key, testCaseId: copy.card.testCaseId, message: error instanceof Error ? error.message : "Recording failed." });
      }
    }
  }
  for (const r of report.results) {
    if (r.result !== "recorded") report.failed.push({ key: `${r.testSetId}:${r.testSetTestCaseId}`, testCaseId: r.testCaseId, message: r.message ?? r.result });
  }
  const recorded = report.results.filter((r) => r.result === "recorded");
  logActivity({
    type: report.failed.length ? "mirror.copiedWithErrors" : "mirror.copied",
    message: `Copied ${recorded.length} result(s) from ${source.name} to the ${target.mirror!.toPlatform} test sets${tester ? ` (${tester})` : ""}.`,
    draftId: targetId,
    module: target.module,
    details: { sourceDraftId: source.id, byStatus: countBy(recorded.map((r) => r.status)) },
  });
  return report;
}

function countBy(statuses: Array<ExecutionStatus | "notRun">): Partial<Record<ExecutionStatus | "notRun", number>> {
  const counts: Partial<Record<ExecutionStatus | "notRun", number>> = {};
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}
