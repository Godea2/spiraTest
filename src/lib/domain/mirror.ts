import { effectiveColumn, isExecutedColumn } from "./board";
import { caseStatus, currentStatus, EXECUTION_STATUS, RUNNER_NAME, runSignature } from "./execution";
import { guessMapping } from "./settings";
import { moduleKey } from "./test-set-suggest";
import type {
  Card,
  Column,
  DefectRecord,
  Draft,
  ExecutedStep,
  ExecutionCaseInput,
  ExecutionRun,
  ExecutionStatus,
  MirrorPair,
  Platform,
  RunDetail,
  SpiraTestSetSummary,
  StepStatus,
} from "./types";

export const COUNTERPART: Partial<Record<Platform, Platform>> = { iOS: "Android", Android: "iOS" };

/** Source runs read per request when copying results step by step. */
export const MAX_RUN_DETAILS = 20;

/** Room left in a step's actual result (4,000 characters) for the note added when it is saved. */
const MAX_COPIED_ACTUAL = 3_400;

/** Columns whose cases stay in the test set after a live apply, strongest first. */
export const KEPT_COLUMNS: readonly Column[] = ["defects", "inScope", "blocked"];

export const isKeptColumn = (column: Column): boolean => KEPT_COLUMNS.includes(column);

/** Where a draft's test sets can be pushed: only when they are all iOS, or all Android. */
export function pushTarget(platforms: Platform[]): Platform | null {
  return platforms.length === 1 ? (COUNTERPART[platforms[0]] ?? null) : null;
}

/**
 * The other platform's test sets for the same module: the same name with the other platform's suffix,
 * those in the source's release first, then the newest.
 */
export function counterpartSets(
  all: SpiraTestSetSummary[],
  source: { testSetId: number; testSetName: string },
  module: string,
  to: Platform,
): SpiraTestSetSummary[] {
  const releaseId = all.find((t) => t.testSetId === source.testSetId)?.releaseId ?? null;
  const keys = new Set([moduleKey(guessMapping(source.testSetName).module), moduleKey(module)]);
  const inRelease = (t: SpiraTestSetSummary) => releaseId !== null && t.releaseId === releaseId;
  return all
    .filter((t) => t.testSetId !== source.testSetId && guessMapping(t.name).platform === to && keys.has(moduleKey(guessMapping(t.name).module)))
    .sort((a, b) => Number(inRelease(b)) - Number(inRelease(a)) || b.testSetId - a.testSetId);
}

export interface MirrorAdd {
  testCaseId: number;
  name: string;
  column: Column;
}

export interface MirrorSetPlan {
  pair: MirrorPair;
  /** Target cards and the column each takes. */
  columns: Array<{ card: Card; column: Column }>;
  /** Test cases the source keeps that the target test set does not hold. */
  add: MirrorAdd[];
}

export interface MirrorPlan {
  sets: MirrorSetPlan[];
  /** The column for every target card: the source's column for a kept case, otherwise Out of Scope. */
  moves: Array<{ key: string; to: Column }>;
  counts: { inScope: number; defects: number; blocked: number; remove: number; add: number };
}

/** The source's kept cases per test case, strongest column first, so a case held twice is matched twice. */
function keptByTestCase(cards: Card[], decisions: Record<string, Column>): Map<number, Array<{ name: string; column: Column }>> {
  const kept = new Map<number, Array<{ name: string; column: Column }>>();
  for (const card of cards) {
    const column = effectiveColumn(card, decisions);
    if (!isKeptColumn(column)) continue;
    kept.set(card.testCaseId, [...(kept.get(card.testCaseId) ?? []), { name: card.name, column }]);
  }
  for (const list of kept.values()) list.sort((a, b) => KEPT_COLUMNS.indexOf(a.column) - KEPT_COLUMNS.indexOf(b.column));
  return kept;
}

/**
 * How the target test sets match the source board: a case the source keeps takes the same column
 * (In Scope, Defects or Blocked), every other case goes to Out of Scope for the live apply to remove,
 * and kept cases the target lacks are listed to be added. Test sets not compared yet are left out.
 */
export function planMirror(source: Pick<Draft, "testSets" | "decisions">, target: Pick<Draft, "testSets">, pairs: MirrorPair[]): MirrorPlan {
  const sets: MirrorSetPlan[] = [];
  const moves: MirrorPlan["moves"] = [];
  const counts = { inScope: 0, defects: 0, blocked: 0, remove: 0, add: 0 };
  for (const pair of pairs) {
    const from = source.testSets.find((s) => s.testSetId === pair.sourceTestSetId);
    const to = target.testSets.find((s) => s.testSetId === pair.targetTestSetId);
    if (!from || !to) continue;
    const kept = keptByTestCase(from.cards, source.decisions);
    const columns = to.cards.map((card) => {
      const column = kept.get(card.testCaseId)?.shift()?.column ?? "outOfScope";
      if (column === "outOfScope") counts.remove += 1;
      else counts[column as "inScope" | "defects" | "blocked"] += 1;
      moves.push({ key: card.key, to: column });
      return { card, column };
    });
    const add = [...kept].flatMap(([testCaseId, left]) => left.map((k) => ({ testCaseId, name: k.name, column: k.column })));
    counts.add += add.length;
    sets.push({ pair, columns, add });
  }
  return { sets, moves, counts };
}

/** True when the target board already puts every card where the plan does and nothing is left to add. */
export function mirrorMatches(plan: MirrorPlan, decisions: Record<string, Column>): boolean {
  return plan.counts.add === 0 && plan.sets.every((s) => s.columns.every(({ card, column }) => effectiveColumn(card, decisions) === column));
}

export interface ResultCopy {
  /** The case on the target board. */
  card: Card;
  /** The same test case on the source board. */
  source: Card;
  sourceSetName: string;
  status: ExecutionStatus;
  /** The run this app recorded on the source that gave this result, if any. */
  run: ExecutionRun | null;
}

export interface ResultPlan {
  copy: ResultCopy[];
  /** Target cases that already have a result; they are left alone. */
  alreadyDone: Card[];
  /** Target cases whose source case has no result yet. */
  notRunOnSource: Card[];
  /** Target cases the source board does not execute. */
  notOnSource: Card[];
}

/** Results to copy: each executed target case takes the latest result its source case shows in Spira. */
export function planResults(source: Draft, target: Draft, pairs: MirrorPair[]): ResultPlan {
  const plan: ResultPlan = { copy: [], alreadyDone: [], notRunOnSource: [], notOnSource: [] };
  for (const pair of pairs) {
    const from = source.testSets.find((s) => s.testSetId === pair.sourceTestSetId);
    const to = target.testSets.find((s) => s.testSetId === pair.targetTestSetId);
    if (!from || !to) continue;
    const executed = new Map<number, Card[]>();
    for (const card of from.cards) {
      if (isExecutedColumn(effectiveColumn(card, source.decisions))) executed.set(card.testCaseId, [...(executed.get(card.testCaseId) ?? []), card]);
    }
    for (const card of to.cards) {
      if (!isExecutedColumn(effectiveColumn(card, target.decisions))) continue;
      const match = executed.get(card.testCaseId)?.shift();
      if (currentStatus(card, target.execution) !== null) plan.alreadyDone.push(card);
      else if (!match) plan.notOnSource.push(card);
      else {
        const status = currentStatus(match, source.execution);
        if (!status) plan.notRunOnSource.push(card);
        else plan.copy.push({ card, source: match, sourceSetName: from.testSetName, status, run: latestRun(source, match, status) });
      }
    }
  }
  return plan;
}

function latestRun(draft: Draft, card: Card, status: ExecutionStatus): ExecutionRun | null {
  const runs = (draft.execution?.runs ?? []).filter((r) => r.testSetId === card.testSetId && r.testSetTestCaseId === card.testSetTestCaseId);
  const latest = runs.reduce<ExecutionRun | null>((a, b) => (!a || b.at > a.at ? b : a), null);
  return latest?.status === status ? latest : null;
}

/** Incidents logged here for the source case, as recorded on the Defects page. */
export function defectsFor(records: DefectRecord[], draftId: string, card: Card): number[] {
  const ids = records
    .filter((r) => r.incidentId && r.cases.some((c) => c.draftId === draftId && c.testSetId === card.testSetId && c.testSetTestCaseId === card.testSetTestCaseId))
    .map((r) => r.incidentId!);
  return [...new Set(ids)].sort((a, b) => a - b);
}

const STEP_STATUS: Record<number, StepStatus> = {
  [EXECUTION_STATUS.failed]: "failed",
  [EXECUTION_STATUS.passed]: "passed",
  [EXECUTION_STATUS.notApplicable]: "notApplicable",
  [EXECUTION_STATUS.blocked]: "blocked",
  [EXECUTION_STATUS.caution]: "caution",
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RUN_NOTE = new RegExp(`\\s*(?:Comment: [\\s\\S]*?\\n)?Executed by [^\\n]*${escapeRegExp(runSignature(RUNNER_NAME))}\\s*$`);

/** An actual result without the note this app adds to a run, so a copy does not carry the first tester's name. */
export function stripRunNote(actualResult: string): string {
  return actualResult.replace(RUN_NOTE, "").trim();
}

/** The source run's steps as marks for the target run, matched by test step ID; empty when they do not give the result. */
export function copiedSteps(detail: RunDetail | undefined, status: ExecutionStatus): ExecutedStep[] {
  if (!detail || detail.steps.length === 0) return [];
  const steps: ExecutedStep[] = detail.steps.map((s, i) => ({
    label: `Step ${i + 1}`,
    testStepId: s.testStepId,
    linkedTestCaseId: null,
    description: "",
    expectedResult: "",
    status: s.statusId ? (STEP_STATUS[s.statusId] ?? null) : null,
    actualResult: clip(stripRunNote(s.actualResult), MAX_COPIED_ACTUAL),
  }));
  return caseStatus(steps.map((s) => s.status)) === status ? steps : [];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Why the target case has this result: where it was copied from, and the defects behind a failure. */
export function copyComment(copy: ResultCopy, from: Platform, incidents: number[], withSteps: boolean): string {
  const parts = [`Same result as on ${from}: ${copy.sourceSetName} (TX:${copy.source.testSetId})${copy.run ? `, test run TR:${copy.run.testRunId}` : ""}.`];
  if (incidents.length) parts.push(`Defect${incidents.length === 1 ? "" : "s"}: ${incidents.map((id) => `IN:${id}`).join(", ")}.`);
  if (!withSteps && copy.run?.comment.trim()) parts.push(`${from} comment: ${clip(copy.run.comment.trim(), 1500)}`);
  return parts.join(" ");
}

/** What is sent to record one copied result. */
export function copyInput(copy: ResultCopy, from: Platform, incidents: number[], detail: RunDetail | undefined): ExecutionCaseInput {
  const steps = copiedSteps(detail, copy.status);
  return {
    testCaseId: copy.card.testCaseId,
    testSetTestCaseId: copy.card.testSetTestCaseId,
    status: copy.status,
    comment: copyComment(copy, from, incidents, steps.length > 0),
    steps,
  };
}
