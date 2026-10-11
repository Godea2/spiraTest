import { chunk, effectiveColumn, isCompleted, MAX_APPLY_BATCH } from "@/lib/domain/board";
import {
  compareMatches,
  defectComment,
  defectProgress,
  defectTargets,
  heldByOtherDefect,
  incidentDescription,
  MAX_DEFECT_CANDIDATES,
  MAX_DEFECT_POOL,
  MAX_DEFECT_SEARCH_CASES,
  MAX_DEFECT_VERIFY_BATCH,
  MAX_STEP_TEXT,
  MAX_VERIFY_STEPS,
  mergeCandidates,
  rankByWording,
  stepsToReproduce,
  type DefectTarget,
  type VerifiedCase,
} from "@/lib/domain/defects";
import { recordDefectMoves, recordExecutionUndo } from "@/lib/domain/draft-ops";
import { currentStatus, executedSteps, RUNNER_NAME, runnableSteps, STATUS_LABEL, type RunnableStep } from "@/lib/domain/execution";
import { MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import type {
  Column,
  DefectAnalysis,
  DefectCandidate,
  DefectCaseRecord,
  DefectLogResult,
  DefectMatch,
  DefectRecord,
  Draft,
  ExecutionCaseInput,
  ExecutionResult,
  IncidentOptions,
} from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api, errorMessage } from "./api";
import { allDrafts, getDraft, mutateDraft } from "./drafts";
import { recordResults, refreshExecution } from "./execution";
import { readItem, writeItem } from "./storage";
import { readTestCase } from "./test-cases";
import { contextOf } from "./workflow";

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

export interface DefectCase {
  target: DefectTarget;
  steps: RunnableStep[];
  candidate: DefectCandidate;
  match: DefectMatch;
}

export interface DefectSearch {
  description: string;
  analysis: DefectAnalysis;
  /** Cases whose names Gemini read, and in how many modules. */
  searched: number;
  modules: number;
  cases: DefectCase[];
}

export type SearchPhase = { stage: "reading"; total: number; modules: number } | { stage: "steps"; done: number; total: number } | { stage: "checking"; done: number; total: number };

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

type Shortlist = { analysis: DefectAnalysis; candidates: DefectCandidate[] };

/**
 * Finds the cases a defect makes fail, across the given drafts (any module, Draft or Completed, and
 * before live apply also Out of Scope and Needs Review cards). Gemini picks candidates from the case
 * names, the app reads their steps from Spira, and Gemini checks each against its steps, naming the
 * failing step and quoting the case. Read-only: nothing is written to Spira.
 */
export async function searchDefect(drafts: Draft[], description: string, onPhase: (phase: SearchPhase) => void): Promise<DefectSearch> {
  if (drafts.length === 0) throw new Error("Choose at least one module to search.");
  const projectId = drafts[0].projectId;
  if (drafts.some((d) => d.projectId !== projectId)) throw new Error("Search the modules of one Spira project at a time.");
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const entries = rankByWording(
    description,
    defectTargets(drafts).map((target) => ({ key: target.card.key, text: `${target.card.name} ${target.card.workbookScenario ?? ""}`, target })),
    MAX_DEFECT_POOL,
  );
  if (entries.length === 0) throw new Error("The chosen modules have no cases left to search.");
  const modules = new Set(entries.map((e) => e.target.module)).size;
  onPhase({ stage: "reading", total: entries.length, modules });

  const parts = chunk(entries, MAX_DEFECT_SEARCH_CASES);
  const lists = await inPool(parts, 2, async (part) => {
    try {
      return await api<Shortlist>("/api/ai/defect/search", {
        method: "POST",
        body: {
          description,
          cases: part.map(({ target }) => {
            const status = currentStatus(target.card, byId.get(target.draftId)?.execution);
            return {
              key: target.card.key,
              module: target.module,
              testSetName: target.testSetName,
              scenario: clip(target.card.name, MAX_SCENARIO_TEXT),
              ...(target.card.workbookScenario ? { workbookScenario: clip(target.card.workbookScenario, MAX_SCENARIO_TEXT) } : {}),
              status: status ? STATUS_LABEL[status] : "Not Run",
            };
          }),
        },
      });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  });
  const answered = lists.filter((l): l is Shortlist => !(l instanceof Error));
  if (answered.length === 0) throw lists[0];
  const analysis = [...answered].sort((a, b) => b.candidates.length - a.candidates.length)[0].analysis;
  const candidates = mergeCandidates(answered.map((l) => l.candidates), MAX_DEFECT_CANDIDATES);
  const searched = parts.reduce((n, part, i) => n + (lists[i] instanceof Error ? 0 : part.length), 0);

  const byKey = new Map(entries.map((e) => [e.key, e.target]));
  const picked = candidates.flatMap((candidate) => {
    const target = byKey.get(candidate.key);
    return target ? [{ target, candidate }] : [];
  });
  if (picked.length === 0) return { description, analysis, searched, modules, cases: [] };

  let read = 0;
  onPhase({ stage: "steps", done: 0, total: picked.length });
  const loaded = await inPool(picked, 4, async ({ target, candidate }) => {
    try {
      const detail = await readTestCase(projectId, target.card.testCaseId);
      return { target, candidate, steps: runnableSteps(detail.steps), error: null };
    } catch (err) {
      return { target, candidate, steps: [] as RunnableStep[], error: errorMessage(err) };
    } finally {
      onPhase({ stage: "steps", done: ++read, total: picked.length });
    }
  });

  const unchecked = (key: string, reason: string): DefectMatch => ({ key, verdict: "possible", confidence: "low", stepLabel: null, evidence: "", grounded: false, reason });
  const matches = new Map<string, DefectMatch>();
  for (const l of loaded) {
    if (l.error) matches.set(l.target.card.key, unchecked(l.target.card.key, `Its steps could not be read from Spira (${l.error}); check it yourself.`));
  }
  const toCheck: VerifiedCase[] = loaded
    .filter((l) => !l.error)
    .map((l) => ({
      key: l.target.card.key,
      module: l.target.module,
      name: clip(l.target.card.name, 2_000),
      steps: l.steps.slice(0, MAX_VERIFY_STEPS).map((s) => ({
        label: s.label,
        description: clip(s.step.description || (s.step.linkedTestCaseId ? `Calls TC${s.step.linkedTestCaseId}` : ""), MAX_STEP_TEXT),
        expectedResult: clip(s.step.expectedResult, MAX_STEP_TEXT),
        sampleData: clip(s.step.sampleData, MAX_STEP_TEXT),
      })),
    }));
  let checked = 0;
  onPhase({ stage: "checking", done: 0, total: toCheck.length });
  let lastError: unknown = null;
  await inPool(chunk(toCheck, MAX_DEFECT_VERIFY_BATCH), 2, async (batch) => {
    try {
      const out = await api<{ matches: DefectMatch[] }>("/api/ai/defect/verify", {
        method: "POST",
        body: { description, analysis: { area: analysis.area, symptom: analysis.symptom, expected: analysis.expected }, cases: batch },
      });
      for (const m of out.matches) matches.set(m.key, m);
    } catch (err) {
      lastError = err;
      for (const c of batch) matches.set(c.key, unchecked(c.key, `Gemini could not check its steps (${errorMessage(err)}); check it yourself.`));
    } finally {
      checked += batch.length;
      onPhase({ stage: "checking", done: checked, total: toCheck.length });
    }
  });
  if (lastError && toCheck.length > 0 && toCheck.every((c) => matches.get(c.key)?.reason.startsWith("Gemini could not"))) throw lastError;

  const cases = loaded
    .map((l) => ({ target: l.target, steps: l.steps, candidate: l.candidate, match: matches.get(l.target.card.key)! }))
    .sort((a, b) => compareMatches(a.match, b.match));
  return { description, analysis, searched, modules, cases };
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

/**
 * Fails every picked case in Spira for one defect, in whatever module it is, then logs the defect as
 * one incident linked to the failed step of each recorded run. Each case first moves to its board's
 * Defects column, which keeps it in its test set and lets it be executed; a case that could not be
 * recorded moves back. Results go in batches per test set, like any other recording.
 */
export async function raiseDefect(
  input: { picks: DefectPick[]; description: string; title: string; expected: string; passBefore: boolean; logIncident: boolean; fields: IncidentFields },
  tester: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean } = {},
): Promise<RaiseOutcome> {
  const { picks, description } = input;
  const title = input.title.trim();
  for (const p of picks) defectCaseInput({ ...p, testCaseId: p.target.card.testCaseId, testSetTestCaseId: p.target.card.testSetTestCaseId }, description, title, input.passBefore);
  const byDraft = new Map<string, DefectPick[]>();
  for (const p of picks) byDraft.set(p.target.draftId, [...(byDraft.get(p.target.draftId) ?? []), p]);

  const results: ExecutionResult[] = [];
  const failed: RaiseOutcome["failed"] = [];
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
      changes = recordDefectMoves(d, ready.map((p) => ({ key: p.target.card.key, to: "defects" as const })), `${label}: moved ${ready.length} card(s) to Defects`, at).length;
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
        recordDefectMoves(d, back, `${label}: moved ${back.length} card(s) back, not recorded`, new Date().toISOString());
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
  if (recordedPicks.length === 0) return { record: null, results, failed, moved, incident: null, incidentError: null };

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
 * cases' statuses again. Whatever could not be deleted stays listed so it can be retried.
 */
export async function undoDefect(defectId: string): Promise<{ errors: string[] }> {
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
      recordDefectMoves(d, stillThere, `Undid defect "${clip(record.title, 80)}": moved ${stillThere.length} card(s) back`, new Date().toISOString());
    });
    try {
      await refreshExecution(draftId, [...new Set(cases.map((c) => c.testSetId))]);
    } catch {
      // The statuses are read again on the next check.
    }
  }

  const remaining = record.cases.filter((c) => !deleted.has(c.testRunId));
  if (!incidentId && remaining.length === 0) forgetDefect(defectId);
  else saveDefect({ ...record, incidentId, cases: remaining });
  logActivity({
    type: errors.length ? "defect.undoneWithErrors" : "defect.undone",
    message: `Undid defect "${record.title}": ${deleted.size} run(s)${record.incidentId && !incidentId ? ` and incident ${record.incidentId}` : ""} deleted from Spira${errors.length ? `; ${errors.length} could not be deleted` : ""}.`,
    details: { defectId, deleted: [...deleted], errors },
  });
  return { errors };
}