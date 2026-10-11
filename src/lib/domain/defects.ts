import { effectiveColumn, isCompleted } from "./board";
import { runSignature, type RunnableStep } from "./execution";
import type { BlockedConfidence, Card, Column, DefectCandidate, DefectMatch, DefectRecord, DefectVerdict, Draft, ExecutionProgress, TestCaseStep } from "./types";

export const MAX_DEFECT_TEXT = 4_000;
/** Case names Gemini reads per request; a search sends several requests. */
export const MAX_DEFECT_SEARCH_CASES = 400;
/** Case names read per search across every module; beyond this, cases are narrowed by wording first. */
export const MAX_DEFECT_POOL = 2_400;
/** Cases one request may pick from names. */
export const MAX_SHORTLIST = 30;
/** Cases picked from names, across requests, for a closer look at their steps; also the most one defect links. */
export const MAX_DEFECT_CANDIDATES = 40;
/** Cases whose steps are checked per request. */
export const MAX_DEFECT_VERIFY_BATCH = 8;
export const MAX_VERIFY_STEPS = 120;
export const MAX_STEP_TEXT = 600;

/** Lower case, straight quotes, and every run of punctuation or spaces as one space. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether a quote appears word for word (ignoring case and punctuation) in any of the texts. */
export function isGrounded(quote: string, texts: string[]): boolean {
  const q = normalizeText(quote);
  if (q.length < 3) return false;
  return texts.some((t) => ` ${normalizeText(t)} `.includes(` ${q} `));
}

/** The text of a case a quote may come from: its name and every step's action, data and expected result. */
export function caseTexts(name: string, steps: Array<Pick<TestCaseStep, "description" | "expectedResult" | "sampleData" | "precondition">>): string[] {
  return [name, ...steps.flatMap((s) => [s.description, s.expectedResult, s.sampleData, s.precondition])].filter((t) => t.trim());
}

const STOP_WORDS = new Set(
  "the and for are but not you all any can had her was one our out has his how its may new now see two who did get let put say she too use when with that this from they them then than what which while into onto user users app does doesnt dont should would could after before there their screen page".split(
    " ",
  ),
);

/** Distinct word stems of a text, for a rough wording match. */
function stems(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

/**
 * Narrows a large list to the cases whose wording shares the most words with the description, keeping
 * the original order among equals. Gemini then reads only these names.
 */
export function rankByWording<T extends { key: string; text: string }>(description: string, items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const wanted = stems(description);
  return items
    .map((item, index) => {
      let score = 0;
      for (const s of stems(item.text)) if (wanted.has(s)) score += 1;
      return { item, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.item);
}

export interface RawDefectVerdict {
  key: string;
  verdict: DefectVerdict;
  confidence: BlockedConfidence;
  stepLabel: string | null;
  evidence: string;
  reason: string;
}

export interface VerifiedCase {
  key: string;
  module?: string;
  name: string;
  steps: Array<{ label: string; description: string; expectedResult: string; sampleData: string }>;
}

/**
 * Gemini's verdicts checked against the cases as sent. A case is only reported as failing when the
 * step exists and the quoted evidence really is in the case's text, with at least medium confidence;
 * otherwise it is offered as possibly affected, for a person to decide. Unknown keys are dropped,
 * and a case Gemini skipped is reported as possibly affected.
 */
export function settleDefectVerdicts(raw: RawDefectVerdict[], cases: VerifiedCase[]): DefectMatch[] {
  const byKey = new Map(cases.map((c) => [c.key, c]));
  const out = new Map<string, DefectMatch>();
  for (const v of raw) {
    const sent = byKey.get(v.key);
    if (!sent || out.has(v.key)) continue;
    const labels = new Set(sent.steps.map((s) => s.label));
    const stepLabel = v.stepLabel && labels.has(v.stepLabel.trim()) ? v.stepLabel.trim() : null;
    const texts = [sent.name, ...sent.steps.flatMap((s) => [s.description, s.expectedResult, s.sampleData])];
    const evidence = v.evidence.trim();
    const grounded = isGrounded(evidence, texts);
    let verdict = v.verdict;
    const stepMissing = sent.steps.length > 0 && stepLabel === null;
    if (verdict === "fails" && (stepMissing || !grounded || v.confidence === "low")) verdict = "possible";
    out.set(v.key, {
      key: v.key,
      verdict,
      confidence: v.confidence,
      stepLabel: verdict === "unaffected" ? null : stepLabel,
      evidence: verdict === "unaffected" ? "" : evidence,
      grounded: verdict !== "unaffected" && grounded,
      reason: v.reason.trim(),
    });
  }
  for (const c of cases) {
    if (!out.has(c.key)) {
      out.set(c.key, { key: c.key, verdict: "possible", confidence: "low", stepLabel: null, evidence: "", grounded: false, reason: "Gemini gave no verdict for this case; check it yourself." });
    }
  }
  return cases.map((c) => out.get(c.key)!);
}

const VERDICT_ORDER: Record<DefectVerdict, number> = { fails: 0, possible: 1, unaffected: 2 };
const CONFIDENCE_ORDER: Record<BlockedConfidence, number> = { high: 0, medium: 1, low: 2 };

/** Failing cases first, then possible, then unaffected; surer verdicts first within each. */
export function compareMatches(a: DefectMatch, b: DefectMatch): number {
  return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
}

/**
 * Marks for a case that fails at one step: the steps before it Passed (when the tester reached the
 * failure through them) or left unmarked, the failing step Failed with what happened, and the steps
 * after it Not Run.
 */
export function defectProgress(steps: RunnableStep[], failLabel: string, actualResult: string, passBefore: boolean): ExecutionProgress {
  const at = steps.findIndex((s) => s.label === failLabel);
  if (at < 0) throw new Error(`Step ${failLabel} is not a step of this case.`);
  const marks: ExecutionProgress["steps"] = {};
  steps.forEach((s, i) => {
    if (i < at && passBefore) marks[s.label] = { status: "passed", actualResult: "" };
    if (i === at) marks[s.label] = { status: "failed", actualResult: actualResult.trim() };
  });
  return { steps: marks, status: null, comment: "" };
}

/** The comment on each failed run: names the defect so the run explains itself in Spira. */
export function defectComment(title: string): string {
  return title.trim() ? `Defect: ${title.trim()}` : "";
}

export interface IncidentCase {
  testCaseId: number;
  name: string;
  module?: string;
  stepLabel: string | null;
  stepText: string;
  testRunId: number;
}

/** Marks an incident as logged by this app; undo only deletes incidents carrying it. */
export function incidentSignature(runner: string): string {
  return `Logged ${runSignature(runner)}`;
}

/**
 * The incident's description: what the tester saw, how to reproduce it (the steps of the first failed
 * case up to the failure, as written in Spira), and every case it failed.
 */
export function incidentDescription(input: {
  runner: string;
  tester: string;
  description: string;
  expected: string;
  reproduce: RunnableStep[];
  failAt: string | null;
  cases: IncidentCase[];
}): string {
  const lines = [input.description.trim(), ""];
  if (input.expected.trim()) lines.push(`Expected: ${input.expected.trim()}`, "");
  if (input.reproduce.length > 0) {
    lines.push("Steps to reproduce:");
    for (const s of input.reproduce) {
      const data = s.step.sampleData.trim() ? ` (data: ${s.step.sampleData.trim()})` : "";
      lines.push(`${s.label}. ${s.step.description.trim() || "(no action text)"}${data}`);
      if (s.label === input.failAt && s.step.expectedResult.trim()) lines.push(`   Expected: ${s.step.expectedResult.trim()}`);
    }
    lines.push("");
  }
  const modules = [...new Set(input.cases.map((c) => c.module ?? ""))];
  lines.push(`Failed test cases (${input.cases.length}${modules.length > 1 ? ` in ${modules.length} modules` : ""}):`);
  for (const name of modules) {
    if (modules.length > 1) lines.push(`${name || "Other"}:`);
    for (const c of input.cases.filter((x) => (x.module ?? "") === name)) {
      lines.push(`- TC${c.testCaseId} ${c.name}${c.stepLabel ? `, step ${c.stepLabel}${c.stepText ? `: ${c.stepText}` : ""}` : ""} (test run ${c.testRunId})`);
    }
  }
  lines.push("", `Found by ${input.tester.trim() || "an unnamed tester"}. ${incidentSignature(input.runner)}`);
  return lines.join("\n").slice(0, 20_000);
}

/** Steps a tester follows to reach the failure: everything up to and including the failing step. */
export function stepsToReproduce(steps: RunnableStep[], failLabel: string | null): RunnableStep[] {
  if (!failLabel) return [];
  const at = steps.findIndex((s) => s.label === failLabel);
  return at < 0 ? [] : steps.slice(0, at + 1);
}

/** A case a defect search may consider: a board card still in its Spira test set, with where it sits. */
export interface DefectTarget {
  draftId: string;
  draftName: string;
  module: string;
  completed: boolean;
  testSetName: string;
  card: Card;
  column: Column;
}

/**
 * Every case of the given drafts that is still in its test set in Spira: before live apply that includes
 * Out of Scope and Needs Review cards (a defect can be found there too); cards a live apply removed are
 * left out. A membership on more than one draft is searched once, from a completed draft first, then
 * the most recently updated.
 */
export function defectTargets(drafts: Draft[]): DefectTarget[] {
  const ordered = [...drafts].sort((a, b) => Number(isCompleted(b.status)) - Number(isCompleted(a.status)) || b.updatedAt.localeCompare(a.updatedAt));
  // A membership a live apply removed is gone from Spira, whichever draft it is on.
  const seen = new Set(drafts.flatMap((d) => Object.entries(d.apply.removed).flatMap(([setId, ids]) => ids.map((id) => `${setId}:${id}`))));
  const out: DefectTarget[] = [];
  for (const draft of ordered) {
    const completed = isCompleted(draft.status);
    for (const set of draft.testSets) {
      for (const card of set.cards) {
        const column = effectiveColumn(card, draft.decisions);
        if ((completed && column === "outOfScope") || seen.has(card.key)) continue;
        seen.add(card.key);
        out.push({ draftId: draft.id, draftName: draft.name, module: draft.module, completed, testSetName: set.testSetName, card, column });
      }
    }
  }
  return out;
}

const RELEVANCE: Record<BlockedConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Joins the shortlists of several requests (each read part of the cases): most relevant first, then
 * taking each list's picks in turn so no part crowds out the others, without repeats, up to `limit`.
 */
export function mergeCandidates(lists: DefectCandidate[][], limit: number): DefectCandidate[] {
  const ranked = lists.flatMap((list, part) => list.map((c, rank) => ({ c, part, rank })));
  ranked.sort((a, b) => RELEVANCE[a.c.relevance] - RELEVANCE[b.c.relevance] || a.rank - b.rank || a.part - b.part);
  const seen = new Set<string>();
  const out: DefectCandidate[] = [];
  for (const { c } of ranked) {
    if (out.length >= limit) break;
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

/** Whether another defect still holds this case, so undoing one defect leaves it in Defects. */
export function heldByOtherDefect(records: DefectRecord[], exceptId: string, draftId: string, key: string): boolean {
  return records.some((r) => r.id !== exceptId && r.cases.some((c) => c.draftId === draftId && `${c.testSetId}:${c.testSetTestCaseId}` === key));
}

/** The Spira list entry that best fits a severity Gemini suggested: by name ("Critical", "1 - High"), else by rank. */
export function pickBySeverity<T extends { id: number; name: string }>(options: T[], severity: string): T | null {
  if (options.length === 0) return null;
  const named = options.find((o) => o.name.toLowerCase().includes(severity));
  if (named) return named;
  const rank = ["critical", "high", "medium", "low"].indexOf(severity);
  return rank < 0 ? null : (options[Math.min(rank, options.length - 1)] ?? null);
}
