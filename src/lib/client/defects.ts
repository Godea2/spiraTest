import { chunk, effectiveColumn, isCompleted, MAX_APPLY_BATCH } from "@/lib/domain/board";
import {
  compareMatches,
  DEFECT_VERIFY_PARALLEL,
  defectComment,
  defectProgress,
  defectTargets,
  heldByOtherDefect,
  incidentDescription,
  MAX_DEFECT_CHECKS,
  MAX_DEFECT_POOL,
  MAX_DEFECT_SEARCH_CASES,
  MAX_DEFECT_VERIFY_BATCH,
  MAX_NEW_CASE_CHOICES,
  MAX_STEP_TEXT,
  MAX_VERIFY_STEPS,
  mergeCandidates,
  failedForDefect,
  rankByWording,
  sameNameCases,
  stepsToReproduce,
  type DefectTarget,
  type VerifiedCase,
} from "@/lib/domain/defects";
import { recordComparison, recordMoves, recordExecutionUndo } from "@/lib/domain/draft-ops";
import { executedSteps, RUNNER_NAME, runnableSteps, type RunnableStep } from "@/lib/domain/execution";
import { MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import type {
  Column,
  CreatedDefectCase,
  DefectAnalysis,
  DefectCandidate,
  DefectCaseCreated,
  DefectCaseRecord,
  DefectLogResult,
  DefectMatch,
  DefectRecord,
  Draft,
  ExecutionCaseInput,
  ExecutionResult,
  IncidentOptions,
  NewDefectCase,
  NewDefectCaseSuggestion,
  Platform,
  TestSetComparison,
  TestSetMapping,
} from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api, ApiError, errorMessage } from "./api";
import { allDrafts, getDraft, mutateDraft } from "./drafts";
import { recordResults, refreshExecution } from "./execution";
import { readItem, writeItem } from "./storage";
import { readTestCase } from "./test-cases";
import { compareTestSet, contextOf } from "./workflow";

// ---- defect log -------------------------------------------------------------

const STORE_KEY = "defects";

function readStore(): DefectRecord[] {
  return readItem<DefectRecord[]>(STORE_KEY) ?? [];
}

function saveDefect(record: DefectRecord): void {
  writeItem(STORE_KEY, [...readStore().filter((d) => d.id !== record.id), record]);
}

function forgetDefect(id: string): void {
  writeItem(STORE_KEY, readStore().filter((d) => d.id !== id));
}

/** Defects found in a Spira project, newest first. */
export function listDefects(projectId: number): DefectRecord[] {
  return readStore()
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.at.localeCompare(a.at));
}

interface LegacyDefect {
  id: string;
  at: string;
  title: string;
  description: string;
  tester: string;
  report: string;
  incidentId: number | null;
  linkedSteps: number;
  cases: Array<{ testSetId: number; testCaseId: number; testSetTestCaseId: number; testRunId: number; stepLabel: string | null }>;
}

/** Moves defects kept inside drafts (before defects had their own list) into the list. Safe to call again. */
export function adoptDraftDefects(): void {
  for (const draft of allDrafts()) {
    const legacy = (draft.execution?.defects ?? []) as LegacyDefect[];
    if (legacy.length === 0) continue;
    const cards = new Map(draft.testSets.flatMap((s) => s.cards).map((c) => [c.key, c]));
    const kept = new Set(readStore().map((d) => d.id));
    for (const d of legacy) {
      if (kept.has(d.id)) continue;
      saveDefect({
        ...d,
        projectId: draft.projectId,
        cases: d.cases.map((c) => ({
          ...c,
          draftId: draft.id,
          module: draft.module,
          name: cards.get(`${c.testSetId}:${c.testSetTestCaseId}`)?.name ?? `TC${c.testCaseId}`,
          from: "inScope",
        })),
      });
    }
    mutateDraft(draft.id, (x) => {
      if (x.execution) delete x.execution.defects;
    });
  }
}

// ---- search -----------------------------------------------------------------

const LEFT_OUT_KEY = "defect-search-left-out";

/** Modules (draft ids) left out of defect searches last time, kept in this browser. */
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

export interface DefectCase {
  target: DefectTarget;
  steps: RunnableStep[];
  candidate: DefectCandidate;
  match: DefectMatch;
}

export interface DefectSearch {
  description: string;
  analysis: DefectAnalysis;
  /** Cases whose names Gemini read, out of how many, and in how many modules. */
  searched: number;
  total: number;
  modules: number;
  /** Why some case names could not be read (or the defect understood); null when every one was. */
  unreadError: string | null;
  /** False when Gemini could not work out the feature, so `analysis` is only the description. */
  understood: boolean;
  /** Every case name was read and every likely case checked against its steps. */
  complete: boolean;
  cases: DefectCase[];
}

/** Stands in for Gemini's reading when it could not answer, so the defect can still become a new test case. */
function unreadAnalysis(description: string): DefectAnalysis {
  const text = description.replace(/\s+/g, " ").trim();
  return { title: clip(text, 120), area: "", feature: "", related: [], symptom: clip(text, 600), expected: "", severity: "medium", question: null };
}

export type SearchPhase =
  | { stage: "understanding"; modules: number }
  | { stage: "reading"; total: number; modules: number; feature: string }
  /** Steps of `read` cases are in from Spira and `done` are checked, of `total`; both run side by side. */
  | { stage: "checking"; read: number; done: number; total: number };

/** Test cases read from Spira at once while their steps are checked. */
const STEP_READS_PARALLEL = 6;

/** Wait before asking again when every Gemini model was busy: demand spikes usually pass within seconds. */
const BUSY_RETRY_MS = 4_000;

/** A Gemini request through the server, asked once more after a short wait when every model was busy. */
async function askGemini<T>(path: string, body: unknown): Promise<T> {
  try {
    return await api<T>(path, { method: "POST", body });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
    await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
    return api<T>(path, { method: "POST", body });
  }
}

/** How each description was read, for this session: searching again (other modules, a retry) skips that step. */
const understood = new Map<string, Promise<DefectAnalysis>>();

function understand(description: string, modules: Array<{ module: string; testSets: string[] }>): Promise<DefectAnalysis> {
  const key = JSON.stringify([description.trim().toLowerCase(), modules]);
  const known = understood.get(key);
  if (known) return known;
  const request = askGemini<DefectAnalysis>("/api/ai/defect/understand", { description, modules });
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
 * Finds the cases a defect makes fail, across the given drafts (any module, Draft or Completed, and
 * before live apply also Out of Scope and Needs Review cards). Gemini first works out which feature
 * the defect is in and what else that feature is called, then picks the cases about that feature from
 * their names, by context rather than shared words; the app reads their steps from Spira, and Gemini
 * checks each against its steps, naming the failing step and quoting the case. A handful of requests
 * per search; the server falls back to other models, and a request is asked once more only when every model
 * was busy. When Gemini still cannot answer, the search ends without cases and says why (`unreadError`), so
 * the defect can be added as a new test case instead. Read-only.
 */
export async function searchDefect(
  drafts: Draft[],
  description: string,
  onPhase: (phase: SearchPhase) => void,
  onPartial?: (search: DefectSearch) => void,
): Promise<DefectSearch> {
  if (drafts.length === 0) throw new Error("Choose at least one module to search.");
  const projectId = drafts[0].projectId;
  if (drafts.some((d) => d.projectId !== projectId)) throw new Error("Search the modules of one Spira project at a time.");
  const targets = defectTargets(drafts);
  if (targets.length === 0) throw new Error("The chosen modules have no cases left to search.");
  const modules = new Set(targets.map((t) => t.module)).size;

  onPhase({ stage: "understanding", modules });
  const outline = new Map<string, Set<string>>();
  for (const t of targets) outline.set(t.module, (outline.get(t.module) ?? new Set()).add(t.testSetName));
  let analysis: DefectAnalysis;
  try {
    analysis = await understand(
      description,
      [...outline].map(([module, sets]) => ({ module, testSets: [...sets].slice(0, 12) })),
    );
  } catch (err) {
    const unread = { description, analysis: unreadAnalysis(description), searched: 0, total: targets.length, modules, understood: false, complete: false };
    return { ...unread, unreadError: `Working out the feature: ${errorMessage(err)}`, cases: [] };
  }
  const reading = { feature: analysis.feature, related: analysis.related, area: analysis.area, symptom: analysis.symptom, expected: analysis.expected };

  // Only a very large search is narrowed first, by the wording of the feature as Gemini read it.
  const entries = rankByWording(
    [description, analysis.feature, analysis.area, ...analysis.related].join(" "),
    targets.map((target) => ({ key: target.card.key, text: `${target.card.name} ${target.card.workbookScenario ?? ""}`, target })),
    MAX_DEFECT_POOL,
  );
  onPhase({ stage: "reading", total: entries.length, modules, feature: analysis.feature || analysis.area });
  const parts = await inPool(chunk(entries, MAX_DEFECT_SEARCH_CASES), 2, async (part) => {
    try {
      const out = await askGemini<{ candidates: DefectCandidate[] }>("/api/ai/defect/search", {
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
  const candidates = mergeCandidates(answered, MAX_DEFECT_CHECKS);
  const result = { description, analysis, searched, total: entries.length, modules, unreadError, understood: true, complete: !failedPart };

  const byKey = new Map(entries.map((e) => [e.key, e.target]));
  const picked = candidates.flatMap((candidate) => {
    const target = byKey.get(candidate.key);
    return target ? [{ target, candidate }] : [];
  });
  if (picked.length === 0) return { ...result, cases: [] };

  // Reading steps from Spira and checking them overlap: a batch goes to Gemini as soon as its cases'
  // steps are in, and the verdicts so far are shown as each batch answers.
  type Loaded = { target: DefectTarget; candidate: DefectCandidate; steps: RunnableStep[] };
  const total = picked.length;
  const loaded = new Map<string, Loaded>();
  const matches = new Map<string, DefectMatch>();
  const unchecked = (key: string, reason: string): DefectMatch => ({ key, verdict: "possible", confidence: "low", stepLabel: null, evidence: "", grounded: false, reason });
  const collect = () =>
    picked
      .flatMap(({ target }) => {
        const l = loaded.get(target.card.key);
        const match = matches.get(target.card.key);
        return l && match ? [{ ...l, match }] : [];
      })
      .sort((a, b) => compareMatches(a.match, b.match));
  let read = 0;
  let checked = 0;
  const progress = () => onPhase({ stage: "checking", read, done: checked, total });
  const report = () => {
    progress();
    onPartial?.({ ...result, cases: collect() });
  };

  const gate = limiter(DEFECT_VERIFY_PARALLEL);
  const checks: Promise<void>[] = [];
  /** Cases whose steps could not be read or checked: offered as possibly affected, for a person to judge. */
  let unverified = 0;
  let pending: VerifiedCase[] = [];
  const send = () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    checks.push(
      gate(async () => {
        try {
          const out = await askGemini<{ matches: DefectMatch[] }>("/api/ai/defect/verify", { description, analysis: reading, cases: batch });
          for (const m of out.matches) matches.set(m.key, m);
        } catch (err) {
          unverified += batch.length;
          for (const c of batch) matches.set(c.key, unchecked(c.key, `Gemini could not check its steps (${errorMessage(err)}); check it yourself.`));
        } finally {
          checked += batch.length;
          report();
        }
      }),
    );
  };

  progress();
  await inPool(picked, STEP_READS_PARALLEL, async ({ target, candidate }) => {
    const key = target.card.key;
    try {
      const steps = runnableSteps((await readTestCase(projectId, target.card.testCaseId)).steps);
      loaded.set(key, { target, candidate, steps });
      pending.push({
        key,
        module: target.module,
        name: clip(target.card.name, 2_000),
        steps: steps.slice(0, MAX_VERIFY_STEPS).map((s) => ({
          label: s.label,
          description: clip(s.step.description || (s.step.linkedTestCaseId ? `Calls TC${s.step.linkedTestCaseId}` : ""), MAX_STEP_TEXT),
          expectedResult: clip(s.step.expectedResult, MAX_STEP_TEXT),
          sampleData: clip(s.step.sampleData, MAX_STEP_TEXT),
        })),
      });
      if (pending.length >= MAX_DEFECT_VERIFY_BATCH) send();
    } catch (err) {
      loaded.set(key, { target, candidate, steps: [] });
      matches.set(key, unchecked(key, `Its steps could not be read from Spira (${errorMessage(err)}); check it yourself.`));
      unverified += 1;
      checked += 1;
    } finally {
      read += 1;
      progress();
    }
  });
  send();
  await Promise.all(checks);
  return { ...result, complete: result.complete && unverified === 0, cases: collect() };
}

/** Runs at most `size` tasks at once; a finished task hands its slot straight to the next waiting one. */
function limiter(size: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (run: () => Promise<void>): Promise<void> => {
    if (active < size) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      await run();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

// ---- new test case ----------------------------------------------------------

const NEW_CASE_STATUS_KEY = "defect-new-case-status";
const AUTO_NEW_CASE_KEY = "defect-auto-new-case";

/** Whether a search where no case fails goes straight on to the new test case's confirmation; on unless turned off. */
export function readAutoNewCase(): boolean {
  return readItem<unknown>(AUTO_NEW_CASE_KEY) !== false;
}

export function storeAutoNewCase(on: boolean): void {
  try {
    writeItem(AUTO_NEW_CASE_KEY, on);
  } catch {
    // Only a convenience: the choice still applies to this visit.
  }
}

/** The test case status last chosen for a new defect case in this project; null for the project's default. */
export function readNewCaseStatus(projectId: number): number | null {
  const stored = readItem<Record<string, unknown>>(NEW_CASE_STATUS_KEY);
  const value = stored?.[String(projectId)];
  return typeof value === "number" ? value : null;
}

export function storeNewCaseStatus(projectId: number, statusId: number | null): void {
  try {
    writeItem(NEW_CASE_STATUS_KEY, { ...(readItem<Record<string, unknown>>(NEW_CASE_STATUS_KEY) ?? {}), [String(projectId)]: statusId });
  } catch {
    // Only a convenience: the choice still applies to this case.
  }
}

/** A test set a new defect case can be added to: one on a searched board. */
export interface NewCaseTarget {
  key: string;
  draftId: string;
  module: string;
  testSetId: number;
  testSetName: string;
  platform: Platform;
}

/** Every test set of the given drafts, once each (from a completed draft first, then the newest). */
export function newCaseTargets(drafts: Draft[]): NewCaseTarget[] {
  const ordered = [...drafts].sort((a, b) => Number(isCompleted(b.status)) - Number(isCompleted(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
  const seen = new Set<number>();
  const out: NewCaseTarget[] = [];
  for (const draft of ordered) {
    for (const set of draft.testSets) {
      if (seen.has(set.testSetId)) continue;
      seen.add(set.testSetId);
      out.push({ key: `${draft.id}|${set.testSetId}`, draftId: draft.id, module: draft.module, testSetId: set.testSetId, testSetName: set.testSetName, platform: set.platform });
    }
  }
  return out.sort((a, b) => a.module.localeCompare(b.module) || a.testSetName.localeCompare(b.testSetName));
}

/**
 * Gemini drafts the test case that would have caught a defect no existing case covers, and picks the
 * test sets it belongs in. It sees each test set's cases closest in wording to the defect, to follow
 * how cases there are named. Changes nothing.
 */
export async function suggestNewCase(drafts: Draft[], search: Pick<DefectSearch, "description" | "analysis">): Promise<NewDefectCaseSuggestion> {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const wording = [search.description, search.analysis.feature, search.analysis.area, ...search.analysis.related].join(" ");
  const testSets = newCaseTargets(drafts)
    .slice(0, MAX_NEW_CASE_CHOICES)
    .map((t) => {
      const cards = byId.get(t.draftId)?.testSets.find((s) => s.testSetId === t.testSetId)?.cards ?? [];
      const examples = rankByWording(wording, cards.map((c) => ({ key: c.key, text: c.name })), 6).map((c) => clip(c.text, MAX_SCENARIO_TEXT));
      return { key: t.key, module: t.module, testSetName: t.testSetName, platform: t.platform, examples };
    });
  if (testSets.length === 0) throw new Error("The chosen modules have no compared test sets.");
  return askGemini<NewDefectCaseSuggestion>("/api/ai/defect/new-case", {
    description: search.description,
    analysis: { feature: search.analysis.feature, area: search.analysis.area, symptom: search.analysis.symptom, expected: search.analysis.expected },
    testSets,
  });
}

/**
 * Existing cases a new defect test case would repeat by name: cases in its chosen test sets, and test cases
 * created for earlier defects of the project. Closest first, each with a label naming it and where it is.
 */
export function newCaseDuplicates(
  projectId: number,
  targets: Array<Pick<NewCaseTarget, "draftId" | "testSetId">>,
  name: string,
  records: DefectRecord[] = listDefects(projectId),
): Array<{ testCaseId: number; label: string }> {
  const existing: Array<{ name: string; testCaseId: number; label: string }> = [];
  for (const t of targets) {
    let draft: Draft;
    try {
      draft = getDraft(t.draftId);
    } catch {
      continue;
    }
    const set = draft.testSets.find((s) => s.testSetId === t.testSetId);
    for (const c of set?.cards ?? []) existing.push({ name: c.name, testCaseId: c.testCaseId, label: `TC${c.testCaseId} "${clip(c.name, 80)}" in ${set!.testSetName}` });
  }
  for (const r of records) {
    if (r.created) existing.push({ name: r.created.name, testCaseId: r.created.testCaseId, label: `TC${r.created.testCaseId}, created for "${clip(r.title, 60)}",` });
  }
  const seen = new Set<number>();
  return sameNameCases(name, existing).filter((c) => !seen.has(c.testCaseId) && seen.add(c.testCaseId));
}

/**
 * Creates the test case in Spira, adds it to each chosen test set, and puts it on each board straight
 * into Defects (In Scope, executed), so it can be failed for the defect. Returns a pick per test set for
 * raiseDefect. If Spira refuses part of it, nothing is left behind; if a board cannot be updated
 * afterwards, that is reported so it can be recompared before a live apply.
 */
export async function createDefectTestCase(
  input: { targets: NewCaseTarget[]; testCase: NewDefectCase },
  mappings: TestSetMapping[],
): Promise<{ created: CreatedDefectCase; picks: DefectPick[]; problems: string[] }> {
  if (input.targets.length === 0) throw new Error("Choose the test set the new case goes in.");
  const draftIds = [...new Set(input.targets.map((t) => t.draftId))];
  const drafts = draftIds.map((id) => getDraft(id));
  const projectId = drafts[0].projectId;
  if (drafts.some((d) => d.projectId !== projectId)) throw new Error("Choose test sets of one Spira project.");
  const repeated = newCaseDuplicates(projectId, input.targets, input.testCase.name)[0];
  if (repeated) throw new Error(`${repeated.label} already has this name, so the test case was not created again.`);
  const boardOf = new Map(draftIds.map((id, i) => [id, i]));
  const { name, description, steps, failingStep, statusId } = input.testCase;
  const out = await api<DefectCaseCreated>("/api/execution/defect/case", {
    method: "POST",
    body: {
      boards: drafts.map((d) => ({ context: contextOf(d), testSets: d.testSets, decisions: d.decisions })),
      testCase: { name, description, steps, statusId: statusId ?? null },
      targets: input.targets.map((t) => ({ board: boardOf.get(t.draftId)!, testSetId: t.testSetId })),
    },
  });
  const created: CreatedDefectCase = {
    testCaseId: out.testCaseId,
    name,
    memberships: out.memberships.map((m) => {
      const target = input.targets.find((t) => t.testSetId === m.testSetId)!;
      return { draftId: target.draftId, module: target.module, testSetId: m.testSetId, testSetTestCaseId: m.testSetTestCaseId };
    }),
  };
  logActivity({
    type: "defect.caseCreated",
    message: `Created test case TC${created.testCaseId} "${name}" for a defect, in ${input.targets.map((t) => t.testSetName).join(", ")}.`,
    module: input.targets.length === 1 ? input.targets[0].module : null,
    details: { testCaseId: created.testCaseId, memberships: created.memberships },
  });

  const problems: string[] = [];
  let caseSteps: RunnableStep[] = [];
  try {
    caseSteps = runnableSteps((await readTestCase(projectId, created.testCaseId)).steps);
  } catch (err) {
    problems.push(`Its steps could not be read back from Spira (${errorMessage(err)}), so the whole case is failed.`);
  }
  const stepLabel = (caseSteps[failingStep - 1] ?? caseSteps.at(-1))?.label ?? null;
  const picks: DefectPick[] = [];
  for (const m of created.memberships) {
    const key = `${m.testSetId}:${m.testSetTestCaseId}`;
    try {
      // The server returns each test set sealed with the new card; a full recompare (which sends the whole
      // workbook) is only the fallback.
      const sealed = out.comparisons?.find((c) => c.comparison.testSetId === m.testSetId)?.comparison;
      const draft = sealed
        ? mutateDraft(m.draftId, (d) => recordComparison(d, sealed, { [key]: "defects" }))
        : await compareTestSet(m.draftId, m.testSetId, mappings, { [key]: "defects" });
      const set = draft.testSets.find((s) => s.testSetId === m.testSetId);
      const card = set?.cards.find((c) => c.key === key);
      if (!set || !card) {
        problems.push(`${m.module}: TC${created.testCaseId} is not in the test set yet. Recompare the board.`);
        continue;
      }
      picks.push({
        target: { draftId: draft.id, draftName: draft.name, module: draft.module, completed: isCompleted(draft.status), testSetName: set.testSetName, card, column: "defects" },
        steps: caseSteps,
        stepLabel,
      });
    } catch (err) {
      problems.push(`${m.module}: the board could not be recompared (${errorMessage(err)}). Recompare it and move TC${created.testCaseId} to Defects before a live apply.`);
    }
  }
  return { created, picks, problems };
}

let optionsRequest: { projectId: number; request: Promise<IncidentOptions> } | null = null;

/** The project's incident types, priorities and severities. Kept for the session; failures are not kept. */
export function readIncidentOptions(projectId: number): Promise<IncidentOptions> {
  if (optionsRequest?.projectId === projectId) return optionsRequest.request;
  const request = api<IncidentOptions>("/api/spira/incident-options", { method: "POST", body: { projectId } });
  optionsRequest = { projectId, request };
  request.catch(() => {
    if (optionsRequest?.request === request) optionsRequest = null;
  });
  return request;
}

// ---- raise ------------------------------------------------------------------

export interface DefectPick {
  target: DefectTarget;
  steps: RunnableStep[];
  /** The step that fails; required when the case has steps. */
  stepLabel: string | null;
}

export interface IncidentFields {
  typeId: number | null;
  priorityId: number | null;
  severityId: number | null;
}

export interface RaiseOutcome {
  record: DefectRecord | null;
  results: ExecutionResult[];
  failed: Array<{ target: DefectTarget; message: string }>;
  /** Cards moved to Defects, per module; their drafts need a fresh membership check before a live apply. */
  moved: Array<{ draftId: string; module: string; count: number; completed: boolean }>;
  incident: DefectLogResult | null;
  incidentError: string | null;
}

/** What each picked case is sent as: a Failed run with the description on the failing step. */
export function defectCaseInput(pick: Pick<DefectPick, "steps" | "stepLabel"> & { testCaseId: number; testSetTestCaseId: number }, description: string, title: string, passBefore: boolean): ExecutionCaseInput {
  const base = { testCaseId: pick.testCaseId, testSetTestCaseId: pick.testSetTestCaseId, status: "failed" as const };
  if (pick.steps.length === 0) {
    return { ...base, comment: [defectComment(title), description.trim()].filter(Boolean).join("\n"), steps: [] };
  }
  if (!pick.stepLabel) throw new Error(`Choose the failing step of TC${pick.testCaseId}.`);
  const progress = defectProgress(pick.steps, pick.stepLabel, description, passBefore);
  return { ...base, comment: defectComment(title), steps: executedSteps(progress, pick.steps) };
}

const pickKey = (draftId: string, key: string) => `${draftId}|${key}`;

/** Why a case cannot be failed again: the defect that already failed it. */
export function alreadyFailedMessage(record: DefectRecord): string {
  const incident = record.incidentId ? `, incident ${record.incidentId}` : "";
  return `Already failed for "${clip(record.title, 80)}" (${new Date(record.at).toLocaleDateString()}${incident}). Undo that defect to fail it again.`;
}

/**
 * Fails every picked case in Spira for one defect, in whatever module it is, then logs the defect as
 * one incident linked to the failed step of each recorded run. Each case first moves to its board's
 * Defects column, which keeps it in its test set and lets it be executed; a case that could not be
 * recorded moves back. Results go in batches per test set, like any other recording.
 */
export async function raiseDefect(
  input: {
    picks: DefectPick[];
    description: string;
    title: string;
    expected: string;
    passBefore: boolean;
    logIncident: boolean;
    fields: IncidentFields;
    /** A test case created for this defect: kept on the record so undo deletes it too. */
    created?: CreatedDefectCase | null;
  },
  tester: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean } = {},
): Promise<RaiseOutcome> {
  const { description } = input;
  const title = input.title.trim();
  for (const p of input.picks) defectCaseInput({ ...p, testCaseId: p.target.card.testCaseId, testSetTestCaseId: p.target.card.testSetTestCaseId }, description, title, input.passBefore);
  const failed: RaiseOutcome["failed"] = [];
  // A case another defect already failed is not failed again: its run and incident are there already.
  const known = readStore();
  const picks = input.picks.filter((p) => {
    const held = failedForDefect(known, p.target.card.testSetId, p.target.card.testSetTestCaseId);
    if (held) failed.push({ target: p.target, message: alreadyFailedMessage(held) });
    return !held;
  });
  const byDraft = new Map<string, DefectPick[]>();
  for (const p of picks) byDraft.set(p.target.draftId, [...(byDraft.get(p.target.draftId) ?? []), p]);

  const results: ExecutionResult[] = [];
  const moved: RaiseOutcome["moved"] = [];
  const from = new Map<string, Column>();
  const recordedKeys = new Set<string>();
  const runs = new Map<string, ExecutionResult>();
  const label = `Defect "${clip(title, 80)}"`;
  let done = 0;

  for (const [draftId, group] of byDraft) {
    if (options.keepGoing && !options.keepGoing()) break;
    let draft: Draft;
    try {
      draft = getDraft(draftId);
    } catch (err) {
      for (const p of group) failed.push({ target: p.target, message: errorMessage(err) });
      continue;
    }
    // Check each case against the draft as it is now, then move what is left to Defects.
    const cards = new Map(draft.testSets.flatMap((s) => s.cards).map((c) => [c.key, c]));
    const ready: DefectPick[] = [];
    for (const p of group) {
      const card = cards.get(p.target.card.key);
      const removed = draft.apply.removed[String(p.target.card.testSetId)]?.includes(p.target.card.testSetTestCaseId);
      if (!card || card.testCaseId !== p.target.card.testCaseId) failed.push({ target: p.target, message: "No longer on its board. Search again." });
      else if (removed) failed.push({ target: p.target, message: "Removed from its test set by a live apply." });
      else {
        from.set(pickKey(draftId, card.key), effectiveColumn(card, draft.decisions));
        ready.push(p);
      }
    }
    if (ready.length === 0) continue;
    const at = new Date().toISOString();
    let changes = 0;
    draft = mutateDraft(draftId, (d) => {
      changes = recordMoves(d, ready.map((p) => ({ key: p.target.card.key, to: "defects" as const })), `${label}: moved ${ready.length} card(s) to Defects`, at).length;
    });
    if (changes > 0) moved.push({ draftId, module: draft.module, count: changes, completed: isCompleted(draft.status) });

    const bySet = new Map<number, DefectPick[]>();
    for (const p of ready) bySet.set(p.target.card.testSetId, [...(bySet.get(p.target.card.testSetId) ?? []), p]);
    for (const [testSetId, setPicks] of bySet) {
      if (options.keepGoing && !options.keepGoing()) break;
      const before = done;
      try {
        const out = await recordResults(
          draftId,
          testSetId,
          setPicks.map((p) => defectCaseInput({ ...p, testCaseId: p.target.card.testCaseId, testSetTestCaseId: p.target.card.testSetTestCaseId }, description, title, input.passBefore)),
          tester,
          { keepGoing: options.keepGoing, onBatch: (n) => options.onProgress?.(before + n, picks.length) },
        );
        results.push(...out.results);
        for (const r of out.results) {
          const p = setPicks.find((x) => x.target.card.testSetTestCaseId === r.testSetTestCaseId);
          if (!p) continue;
          if (r.result === "recorded" && r.testRunId !== null) {
            recordedKeys.add(pickKey(draftId, p.target.card.key));
            runs.set(pickKey(draftId, p.target.card.key), r);
          } else failed.push({ target: p.target, message: r.message ?? r.result });
        }
      } catch (err) {
        for (const p of setPicks) failed.push({ target: p.target, message: errorMessage(err) });
      }
      done = before + setPicks.length;
      options.onProgress?.(done, picks.length);
    }

    // A case that was not failed in Spira goes back where it was.
    const back = ready
      .filter((p) => !recordedKeys.has(pickKey(draftId, p.target.card.key)))
      .map((p) => ({ key: p.target.card.key, to: from.get(pickKey(draftId, p.target.card.key)) ?? "inScope" }))
      .filter((m) => m.to !== "defects");
    if (back.length > 0) {
      mutateDraft(draftId, (d) => {
        recordMoves(d, back, `${label}: moved ${back.length} card(s) back, not recorded`, new Date().toISOString());
      });
      const m = moved.find((x) => x.draftId === draftId);
      if (m) m.count = Math.max(0, m.count - back.length);
    }
  }
  for (let i = moved.length - 1; i >= 0; i--) if (moved[i].count === 0) moved.splice(i, 1);
  const reported = new Set(failed.map((f) => pickKey(f.target.draftId, f.target.card.key)));
  for (const p of picks) {
    const key = pickKey(p.target.draftId, p.target.card.key);
    if (!recordedKeys.has(key) && !reported.has(key)) failed.push({ target: p.target, message: "Stopped before it was recorded." });
  }

  const recordedPicks = picks.filter((p) => recordedKeys.has(pickKey(p.target.draftId, p.target.card.key)));
  const created = input.created ?? null;
  if (recordedPicks.length === 0) {
    if (!created) return { record: null, results, failed, moved, incident: null, incidentError: null };
    // Nothing was failed, but the new test case is in Spira: keep it listed so it can be failed by hand or undone.
    const record: DefectRecord = {
      id: crypto.randomUUID(),
      projectId: getDraft(created.memberships[0]?.draftId ?? picks[0].target.draftId).projectId,
      at: new Date().toISOString(),
      title,
      description: description.trim(),
      tester,
      report: "",
      incidentId: null,
      linkedSteps: 0,
      cases: [],
      created,
    };
    saveDefect(record);
    return { record, results, failed, moved, incident: null, incidentError: null };
  }

  const first = recordedPicks.find((p) => p.steps.length > 0) ?? recordedPicks[0];
  const runOf = (p: DefectPick) => runs.get(pickKey(p.target.draftId, p.target.card.key))!;
  const report = incidentDescription({
    runner: RUNNER_NAME,
    tester,
    description,
    expected: input.expected,
    reproduce: stepsToReproduce(first.steps, first.stepLabel),
    failAt: first.stepLabel,
    cases: recordedPicks.map((p) => ({
      testCaseId: p.target.card.testCaseId,
      name: p.target.card.name,
      module: p.target.module,
      stepLabel: p.stepLabel,
      stepText: clip(p.steps.find((s) => s.label === p.stepLabel)?.step.description ?? "", 120),
      testRunId: runOf(p).testRunId!,
    })),
  });
  const record: DefectRecord = {
    id: crypto.randomUUID(),
    projectId: getDraft(first.target.draftId).projectId,
    at: new Date().toISOString(),
    title,
    description: description.trim(),
    tester,
    report,
    incidentId: null,
    linkedSteps: 0,
    cases: recordedPicks.map(
      (p): DefectCaseRecord => ({
        draftId: p.target.draftId,
        module: p.target.module,
        testSetId: p.target.card.testSetId,
        testCaseId: p.target.card.testCaseId,
        testSetTestCaseId: p.target.card.testSetTestCaseId,
        name: p.target.card.name,
        testRunId: runOf(p).testRunId!,
        stepLabel: p.stepLabel,
        from: from.get(pickKey(p.target.draftId, p.target.card.key)) ?? "inScope",
      }),
    ),
    created,
  };
  saveDefect(record);
  const modules = [...new Set(record.cases.map((c) => c.module))];
  logActivity({
    type: "defect.casesFailed",
    message: `Failed ${record.cases.length} case(s) in ${modules.join(", ")} for defect "${record.title}".`,
    draftId: modules.length === 1 ? record.cases[0].draftId : null,
    module: modules.length === 1 ? modules[0] : null,
    details: { defectId: record.id, testRunIds: record.cases.map((c) => c.testRunId), moved },
  });

  if (!input.logIncident) return { record, results, failed, moved, incident: null, incidentError: null };
  try {
    const logged = await logIncident(record.id, input.fields);
    return { record: logged.record, results, failed, moved, incident: logged.incident, incidentError: null };
  } catch (err) {
    return { record, results, failed, moved, incident: null, incidentError: errorMessage(err) };
  }
}

/** Logs a kept defect as a Spira incident linked to the failed step of each of its runs, across modules. */
export async function logIncident(defectId: string, fields: IncidentFields): Promise<{ record: DefectRecord; incident: DefectLogResult }> {
  const record = readStore().find((d) => d.id === defectId);
  if (!record) throw new Error("This defect is no longer in the list.");
  if (record.incidentId) throw new Error(`This defect is already logged as incident ${record.incidentId}.`);
  const draftIds = [...new Set(record.cases.map((c) => c.draftId))];
  const drafts = draftIds.map((id) => {
    try {
      return getDraft(id);
    } catch {
      return null;
    }
  });
  const boards = drafts.flatMap((d) => (d ? [{ context: contextOf(d), testSets: d.testSets, decisions: d.decisions }] : []));
  const boardOf = new Map(drafts.flatMap((d) => (d ? [d.id] : [])).map((id, i) => [id, i]));
  const runs = record.cases.flatMap((c) => {
    const board = boardOf.get(c.draftId);
    return board === undefined ? [] : [{ board, testRunId: c.testRunId, testCaseId: c.testCaseId, testSetId: c.testSetId, testSetTestCaseId: c.testSetTestCaseId }];
  });
  if (runs.length === 0) throw new Error("The drafts of this defect's cases were deleted, so its runs cannot be checked.");
  const incident = await api<DefectLogResult>("/api/execution/defect", {
    method: "POST",
    body: { boards, defect: { name: record.title || clip(record.description, 120), description: record.report, ...fields }, runs },
  });
  const updated: DefectRecord = { ...record, incidentId: incident.incidentId, linkedSteps: incident.linked.length };
  saveDefect(updated);
  const modules = [...new Set(record.cases.map((c) => c.module))];
  logActivity({
    type: "defect.logged",
    message: `Logged incident ${incident.incidentId} "${updated.title}", linked to ${incident.linked.length} failed run(s) in ${modules.join(", ")}.`,
    module: modules.length === 1 ? modules[0] : null,
    details: { defectId, incidentId: incident.incidentId, linked: incident.linked, unlinked: incident.unlinked },
  });
  return { record: updated, incident };
}

/**
 * Undoes a defect: deletes its incident and the runs recorded for it (each checked to be this app's),
 * moves each case back to the column it came from unless another defect still holds it, then reads the
 * cases' statuses again. A test case created for the defect is deleted too (also checked to be this
 * app's) and its boards recompared. Whatever could not be deleted stays listed so it can be retried.
 */
export async function undoDefect(defectId: string, mappings: TestSetMapping[]): Promise<{ errors: string[] }> {
  const record = readStore().find((d) => d.id === defectId);
  if (!record) throw new Error("This defect is no longer in the list.");
  const errors: string[] = [];
  let incidentId = record.incidentId;
  if (incidentId) {
    try {
      await api("/api/execution/defect/undo", { method: "POST", body: { projectId: record.projectId, incidentId } });
      incidentId = null;
    } catch (err) {
      errors.push(`Incident ${incidentId}: ${errorMessage(err)}`);
    }
  }

  const deleted = new Set<number>();
  const others = readStore();
  for (const draftId of new Set(record.cases.map((c) => c.draftId))) {
    const cases = record.cases.filter((c) => c.draftId === draftId);
    let draft: Draft;
    try {
      draft = getDraft(draftId);
    } catch {
      errors.push(`${cases[0].module}: the draft was deleted, so its ${cases.length} run(s) were left in Spira.`);
      continue;
    }
    const gone: number[] = [];
    for (const batch of chunk(cases, MAX_APPLY_BATCH)) {
      try {
        const { results } = await api<{ results: { testRunId: number; ok: boolean; message: string | null }[] }>("/api/workflow/undo-sign-off", {
          method: "POST",
          body: { context: contextOf(draft), runs: batch.map((c) => ({ testRunId: c.testRunId, testCaseId: c.testCaseId })) },
        });
        for (const r of results) {
          if (r.ok) gone.push(r.testRunId);
          else errors.push(`Test run ${r.testRunId}: ${r.message ?? "not deleted"}`);
        }
      } catch (err) {
        errors.push(`${draft.module}: ${errorMessage(err)}`);
      }
    }
    for (const id of gone) deleted.add(id);
    const back = cases
      .filter((c) => gone.includes(c.testRunId) && c.from !== "defects")
      .map((c) => ({ key: `${c.testSetId}:${c.testSetTestCaseId}`, to: c.from }))
      .filter((m) => !heldByOtherDefect(others, record.id, draftId, m.key));
    mutateDraft(draftId, (d) => {
      recordExecutionUndo(d, gone);
      const cards = new Map(d.testSets.flatMap((s) => s.cards).map((c) => [c.key, c]));
      const stillThere = back.filter((m) => {
        const card = cards.get(m.key);
        return card && effectiveColumn(card, d.decisions) === "defects";
      });
      recordMoves(d, stillThere, `Undid defect "${clip(record.title, 80)}": moved ${stillThere.length} card(s) back`, new Date().toISOString());
    });
    try {
      await refreshExecution(draftId, [...new Set(cases.map((c) => c.testSetId))]);
    } catch {
      // The statuses are read again on the next check.
    }
  }

  const remaining = record.cases.filter((c) => !deleted.has(c.testRunId));

  // The test case created for the defect goes last, once none of its runs is left.
  const made = record.created ?? null;
  let created = made;
  if (made && !remaining.some((c) => c.testCaseId === made.testCaseId)) {
    try {
      const boardDrafts = [...new Set(made.memberships.map((m) => m.draftId))].flatMap((id) => {
        try {
          return [getDraft(id)];
        } catch {
          return [];
        }
      });
      const undone = await api<{ comparisons?: Array<{ board: number; comparison: TestSetComparison }> }>("/api/execution/defect/case/undo", {
        method: "POST",
        body: {
          projectId: record.projectId,
          testCaseId: made.testCaseId,
          memberships: made.memberships.map(({ testSetId, testSetTestCaseId }) => ({ testSetId, testSetTestCaseId })),
          boards: boardDrafts.map((d) => ({ context: contextOf(d), testSets: d.testSets })),
        },
      });
      created = null;
      for (const m of made.memberships) {
        const board = boardDrafts.findIndex((d) => d.id === m.draftId);
        const sealed = undone.comparisons?.find((c) => c.board === board && c.comparison.testSetId === m.testSetId)?.comparison;
        try {
          if (sealed) mutateDraft(m.draftId, (d) => recordComparison(d, sealed));
          else if (board >= 0 && boardDrafts[board].testSets.some((s) => s.testSetId === m.testSetId && s.cards.some((c) => c.testCaseId === made.testCaseId))) {
            await compareTestSet(m.draftId, m.testSetId, mappings);
          }
        } catch (err) {
          errors.push(`${m.module}: TC${made.testCaseId} was deleted, but the board could not be recompared (${errorMessage(err)}). Recompare it.`);
        }
      }
    } catch (err) {
      errors.push(`Test case ${made.testCaseId}: ${errorMessage(err)}`);
    }
  }

  if (!incidentId && remaining.length === 0 && !created) forgetDefect(defectId);
  else saveDefect({ ...record, incidentId, cases: remaining, created });
  const deletedCase = record.created && !created ? ` and test case TC${record.created.testCaseId}` : "";
  logActivity({
    type: errors.length ? "defect.undoneWithErrors" : "defect.undone",
    message: `Undid defect "${record.title}": ${deleted.size} run(s)${record.incidentId && !incidentId ? `, incident ${record.incidentId}` : ""}${deletedCase} deleted from Spira${errors.length ? `; ${errors.length} could not be deleted` : ""}.`,
    details: { defectId, deleted: [...deleted], errors },
  });
  return { errors };
}