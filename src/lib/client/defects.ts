import { chunk, MAX_APPLY_BATCH } from "@/lib/domain/board";
import {
  compareMatches,
  defectComment,
  defectProgress,
  incidentDescription,
  MAX_DEFECT_SEARCH_CASES,
  MAX_DEFECT_VERIFY_BATCH,
  MAX_STEP_TEXT,
  MAX_VERIFY_STEPS,
  rankByWording,
  stepsToReproduce,
  type VerifiedCase,
} from "@/lib/domain/defects";
import { recordDefect, recordExecutionUndo, removeDefect } from "@/lib/domain/draft-ops";
import { currentStatus, executedSteps, RUNNER_NAME, runnableSteps, STATUS_LABEL, type RunnableStep } from "@/lib/domain/execution";
import { MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import type {
  Card,
  DefectAnalysis,
  DefectCandidate,
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
import { getDraft, mutateDraft } from "./drafts";
import { recordResults, refreshExecution } from "./execution";
import { readTestCase } from "./test-cases";
import { contextOf } from "./workflow";
export interface DefectCase {
  card: Card;
  steps: RunnableStep[];
  candidate: DefectCandidate;
  match: DefectMatch;
}

export interface DefectSearch {
  description: string;
  analysis: DefectAnalysis;
  /** Cases whose names Gemini read. */
  searched: number;
  cases: DefectCase[];
}

export type SearchPhase = { stage: "reading"; total: number } | { stage: "steps"; done: number; total: number } | { stage: "checking"; done: number; total: number };

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
 * Finds the cases a defect makes fail: Gemini picks candidates from the case names, the app reads their
 * steps from Spira, and Gemini checks each against its steps, naming the failing step and quoting the
 * case. Read-only: nothing is written to Spira.
 */
export async function searchDefect(draft: Draft, description: string, cards: Card[], onPhase: (phase: SearchPhase) => void): Promise<DefectSearch> {
  const setName = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `Test set ${id}`;
  const entries = rankByWording(
    description,
    cards.map((card) => ({ key: card.key, text: `${card.name} ${card.workbookScenario ?? ""}`, card })),
    MAX_DEFECT_SEARCH_CASES,
  );
  onPhase({ stage: "reading", total: entries.length });
  const { analysis, candidates } = await api<{ analysis: DefectAnalysis; candidates: DefectCandidate[] }>("/api/ai/defect/search", {
    method: "POST",
    body: {
      module: draft.module,
      description,
      cases: entries.map(({ card }) => {
        const status = currentStatus(card, draft.execution);
        return {
          key: card.key,
          testSetName: setName(card.testSetId),
          scenario: clip(card.name, MAX_SCENARIO_TEXT),
          ...(card.workbookScenario ? { workbookScenario: clip(card.workbookScenario, MAX_SCENARIO_TEXT) } : {}),
          status: status ? STATUS_LABEL[status] : "Not Run",
        };
      }),
    },
  });
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const picked = candidates.flatMap((candidate) => {
    const card = byKey.get(candidate.key);
    return card ? [{ card, candidate }] : [];
  });
  if (picked.length === 0) return { description, analysis, searched: entries.length, cases: [] };

  let read = 0;
  onPhase({ stage: "steps", done: 0, total: picked.length });
  const loaded = await inPool(picked, 4, async ({ card, candidate }) => {
    try {
      const detail = await readTestCase(draft.projectId, card.testCaseId);
      return { card, candidate, steps: runnableSteps(detail.steps), error: null };
    } catch (err) {
      return { card, candidate, steps: [] as RunnableStep[], error: errorMessage(err) };
    } finally {
      onPhase({ stage: "steps", done: ++read, total: picked.length });
    }
  });

  const matches = new Map<string, DefectMatch>();
  for (const l of loaded) {
    if (l.error) {
      matches.set(l.card.key, { key: l.card.key, verdict: "possible", confidence: "low", stepLabel: null, evidence: "", grounded: false, reason: `Its steps could not be read from Spira (${l.error}); check it yourself.` });
    }
  }
  const toCheck: VerifiedCase[] = loaded
    .filter((l) => !l.error)
    .map((l) => ({
      key: l.card.key,
      name: clip(l.card.name, 2_000),
      steps: l.steps.slice(0, MAX_VERIFY_STEPS).map((s) => ({
        label: s.label,
        description: clip(s.step.description || (s.step.linkedTestCaseId ? `Calls TC${s.step.linkedTestCaseId}` : ""), MAX_STEP_TEXT),
        expectedResult: clip(s.step.expectedResult, MAX_STEP_TEXT),
        sampleData: clip(s.step.sampleData, MAX_STEP_TEXT),
      })),
    }));
  let checked = 0;
  onPhase({ stage: "checking", done: 0, total: toCheck.length });
  const batches = chunk(toCheck, MAX_DEFECT_VERIFY_BATCH);
  let lastError: unknown = null;
  await inPool(batches, 2, async (batch) => {
    try {
      const out = await api<{ matches: DefectMatch[] }>("/api/ai/defect/verify", {
        method: "POST",
        body: { module: draft.module, description, analysis: { area: analysis.area, symptom: analysis.symptom, expected: analysis.expected }, cases: batch },
      });
      for (const m of out.matches) matches.set(m.key, m);
    } catch (err) {
      lastError = err;
      for (const c of batch) {
        matches.set(c.key, { key: c.key, verdict: "possible", confidence: "low", stepLabel: null, evidence: "", grounded: false, reason: `Gemini could not check its steps (${errorMessage(err)}); check it yourself.` });
      }
    } finally {
      checked += batch.length;
      onPhase({ stage: "checking", done: checked, total: toCheck.length });
    }
  });
  if (lastError && toCheck.length > 0 && toCheck.every((c) => matches.get(c.key)?.reason.startsWith("Gemini could not"))) throw lastError;

  const cases = loaded
    .map((l) => ({ card: l.card, steps: l.steps, candidate: l.candidate, match: matches.get(l.card.key)! }))
    .sort((a, b) => compareMatches(a.match, b.match));
  return { description, analysis, searched: entries.length, cases };
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

export interface DefectPick {
  card: Card;
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
  draft: Draft;
  record: DefectRecord | null;
  results: ExecutionResult[];
  failed: Array<{ card: Card; message: string }>;
  incident: DefectLogResult | null;
  incidentError: string | null;
}

/** What each picked case is sent as: a Failed run with the description on the failing step. */
export function defectCaseInput(pick: DefectPick, description: string, title: string, passBefore: boolean): ExecutionCaseInput {
  const base = { testCaseId: pick.card.testCaseId, testSetTestCaseId: pick.card.testSetTestCaseId, status: "failed" as const };
  if (pick.steps.length === 0) {
    return { ...base, comment: [defectComment(title), description.trim()].filter(Boolean).join("\n"), steps: [] };
  }
  if (!pick.stepLabel) throw new Error(`Choose the failing step of TC${pick.card.testCaseId}.`);
  const progress = defectProgress(pick.steps, pick.stepLabel, description, passBefore);
  return { ...base, comment: defectComment(title), steps: executedSteps(progress, pick.steps) };
}

/**
 * Fails every picked case in Spira for one defect, then logs the defect as one incident linked to the
 * failed step of each recorded run. Results go in batches per test set, like any other recording.
 */
export async function raiseDefect(
  draftId: string,
  input: { picks: DefectPick[]; description: string; title: string; expected: string; passBefore: boolean; logIncident: boolean; fields: IncidentFields },
  tester: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean } = {},
): Promise<RaiseOutcome> {
  const { picks, description, title } = input;
  const cases = new Map(picks.map((p) => [p.card.key, p]));
  const bySet = new Map<number, DefectPick[]>();
  for (const p of picks) bySet.set(p.card.testSetId, [...(bySet.get(p.card.testSetId) ?? []), p]);

  const results: ExecutionResult[] = [];
  const failed: RaiseOutcome["failed"] = [];
  let draft = getDraft(draftId);
  for (const [testSetId, group] of bySet) {
    if (options.keepGoing && !options.keepGoing()) break;
    const before = results.length;
    try {
      const out = await recordResults(
        draftId,
        testSetId,
        group.map((p) => defectCaseInput(p, description, title, input.passBefore)),
        tester,
        { keepGoing: options.keepGoing, onBatch: (done) => options.onProgress?.(before + done, picks.length) },
      );
      results.push(...out.results);
      draft = out.draft;
    } catch (err) {
      const sent = new Set(results.map((r) => `${r.testSetId}:${r.testSetTestCaseId}`));
      for (const p of group) if (!sent.has(p.card.key)) failed.push({ card: p.card, message: errorMessage(err) });
    }
  }
  for (const r of results) {
    const pick = cases.get(`${r.testSetId}:${r.testSetTestCaseId}`);
    if (r.result !== "recorded" && pick) failed.push({ card: pick.card, message: r.message ?? r.result });
  }
  const recorded = results.filter((r) => r.result === "recorded" && r.testRunId !== null);
  if (recorded.length === 0) return { draft, record: null, results, failed, incident: null, incidentError: null };

  const recordedPicks = recorded.map((r) => ({ r, pick: cases.get(`${r.testSetId}:${r.testSetTestCaseId}`)! }));
  const first = recordedPicks.find((x) => x.pick.steps.length > 0)?.pick ?? recordedPicks[0].pick;
  const report = incidentDescription({
    runner: RUNNER_NAME,
    tester,
    description,
    expected: input.expected,
    reproduce: stepsToReproduce(first.steps, first.stepLabel),
    failAt: first.stepLabel,
    cases: recordedPicks.map(({ r, pick }) => ({
      testCaseId: pick.card.testCaseId,
      name: pick.card.name,
      stepLabel: pick.stepLabel,
      stepText: clip(pick.steps.find((s) => s.label === pick.stepLabel)?.step.description ?? "", 120),
      testRunId: r.testRunId!,
    })),
  });
  const record: DefectRecord = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    title: title.trim(),
    description: description.trim(),
    tester,
    report,
    incidentId: null,
    linkedSteps: 0,
    cases: recordedPicks.map(({ r, pick }) => ({
      testSetId: r.testSetId,
      testCaseId: r.testCaseId,
      testSetTestCaseId: r.testSetTestCaseId,
      testRunId: r.testRunId!,
      stepLabel: pick.stepLabel,
    })),
  };
  draft = mutateDraft(draftId, (d) => recordDefect(d, record));
  logActivity({
    type: "execution.defectFailed",
    message: `Failed ${recorded.length} case(s) for defect "${record.title}".`,
    draftId,
    module: draft.module,
    details: { defectId: record.id, testRunIds: record.cases.map((c) => c.testRunId) },
  });

  if (!input.logIncident) return { draft, record, results, failed, incident: null, incidentError: null };
  try {
    const logged = await logIncident(draftId, record.id, input.fields);
    return { draft: logged.draft, record: logged.record, results, failed, incident: logged.incident, incidentError: null };
  } catch (err) {
    return { draft, record, results, failed, incident: null, incidentError: errorMessage(err) };
  }
}

/** Logs a kept defect as a Spira incident linked to the failed step of each of its runs. */
export async function logIncident(draftId: string, defectId: string, fields: IncidentFields): Promise<{ draft: Draft; record: DefectRecord; incident: DefectLogResult }> {
  const draft = getDraft(draftId);
  const record = draft.execution?.defects?.find((d) => d.id === defectId);
  if (!record) throw new Error("This defect is no longer in the draft.");
  if (record.incidentId) throw new Error(`This defect is already logged as incident ${record.incidentId}.`);
  const incident = await api<DefectLogResult>("/api/execution/defect", {
    method: "POST",
    body: {
      context: contextOf(draft),
      testSets: draft.testSets,
      decisions: draft.decisions,
      defect: { name: record.title || clip(record.description, 120), description: record.report, ...fields },
      runs: record.cases.map((c) => ({ testRunId: c.testRunId, testCaseId: c.testCaseId, testSetId: c.testSetId, testSetTestCaseId: c.testSetTestCaseId })),
    },
  });
  const updated: DefectRecord = { ...record, incidentId: incident.incidentId, linkedSteps: incident.linked.length };
  const saved = mutateDraft(draftId, (d) => recordDefect(d, updated));
  logActivity({
    type: "execution.defectLogged",
    message: `Logged incident ${incident.incidentId} "${updated.title}", linked to ${incident.linked.length} failed run(s).`,
    draftId,
    module: draft.module,
    details: { defectId, incidentId: incident.incidentId, linked: incident.linked, unlinked: incident.unlinked },
  });
  return { draft: saved, record: updated, incident };
}

/**
 * Undoes a defect: deletes its incident and the runs recorded for it (each checked to be this app's),
 * then reads the cases' statuses again. Whatever could not be deleted stays listed so it can be retried.
 */
export async function undoDefect(draftId: string, defectId: string): Promise<{ draft: Draft; errors: string[] }> {
  const draft = getDraft(draftId);
  const record = draft.execution?.defects?.find((d) => d.id === defectId);
  if (!record) throw new Error("This defect is no longer in the draft.");
  const errors: string[] = [];
  let incidentId = record.incidentId;
  if (incidentId) {
    try {
      await api("/api/execution/defect/undo", { method: "POST", body: { projectId: draft.projectId, incidentId } });
      incidentId = null;
    } catch (err) {
      errors.push(`Incident ${incidentId}: ${errorMessage(err)}`);
    }
  }
  const deleted: number[] = [];
  for (const batch of chunk(record.cases, MAX_APPLY_BATCH)) {
    try {
      const { results } = await api<{ results: { testRunId: number; ok: boolean; message: string | null }[] }>("/api/workflow/undo-sign-off", {
        method: "POST",
        body: { context: contextOf(draft), runs: batch.map((c) => ({ testRunId: c.testRunId, testCaseId: c.testCaseId })) },
      });
      for (const r of results) {
        if (r.ok) deleted.push(r.testRunId);
        else errors.push(`Test run ${r.testRunId}: ${r.message ?? "not deleted"}`);
      }
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  const remaining = record.cases.filter((c) => !deleted.includes(c.testRunId));
  let updated = mutateDraft(draftId, (d) => {
    recordExecutionUndo(d, deleted);
    if (!incidentId && remaining.length === 0) removeDefect(d, defectId);
    else recordDefect(d, { ...record, incidentId, cases: remaining });
  });
  logActivity({
    type: errors.length ? "execution.defectUndoneWithErrors" : "execution.defectUndone",
    message: `Undid defect "${record.title}": ${deleted.length} run(s)${record.incidentId && !incidentId ? ` and incident ${record.incidentId}` : ""} deleted from Spira${errors.length ? `; ${errors.length} could not be deleted` : ""}.`,
    draftId,
    module: draft.module,
    details: { defectId, deleted, errors },
  });
  try {
    updated = (await refreshExecution(draftId, [...new Set(record.cases.map((c) => c.testSetId))])).draft;
  } catch {
    // The statuses are read again on the next check.
  }
  return { draft: updated, errors };
}
