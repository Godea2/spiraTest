import type { ApplyBatchInput } from "@/lib/domain/apply-rules";
import { allCards, chunk, completionBlocker, countColumns, MAX_APPLY_BATCH } from "@/lib/domain/board";
import {
  adoptSpiraRemovals,
  recordCleanCompletion,
  recordApplyResults,
  recordCompareError,
  recordComparison,
  recordPreflight,
  recordSignOffResults,
  recordSignOffUndo,
  recordBlockedReview,
  recordVerification,
} from "@/lib/domain/draft-ops";
import { keywordAssessment, MAX_AI_REVIEW_BATCH, type BlockedCandidate } from "@/lib/domain/keywords";
import type {
  AiBlockedVerdict,
  ApplyActionResult,
  BlockedAssessment,
  Draft,
  PreflightResult,
  SignOffResult,
  SignOffRun,
  SignOffStatus,
  TestSetComparison,
  TestSetMapping,
  VerificationResult,
  WorkflowContext,
} from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api, errorMessage } from "./api";
import { getDraft, mutateDraft } from "./drafts";

// The server is stateless: each call carries the board it acts on and the draft
// in this browser is updated with the result.

export interface SignOffBatchInput extends ApplyBatchInput {
  status: SignOffStatus;
}

export const contextOf = (draft: Draft): WorkflowContext => ({
  projectId: draft.projectId,
  releaseId: draft.releaseId,
  module: draft.module,
});

/** Compares one test set and stores the result in the draft, preserving manual decisions. */
export async function compareTestSet(
  draftId: string,
  testSetId: number,
  mappings: TestSetMapping[],
): Promise<Draft> {
  const draft = getDraft(draftId);
  if (!draft.testSetIds.includes(testSetId)) throw new Error(`Test set ${testSetId} is not part of this draft.`);
  const mapping =
    draft.testSetRefs?.find((r) => r.testSetId === testSetId) ??
    mappings.find((m) => m.testSetId === testSetId && m.module === draft.module) ??
    draft.testSets.find((s) => s.testSetId === testSetId);
  if (!mapping) throw new Error(`Test set ${testSetId} is not mapped to ${draft.module} in Settings.`);

  let comparison: TestSetComparison;
  try {
    ({ comparison } = await api<{ comparison: TestSetComparison }>("/api/workflow/reconcile", {
      method: "POST",
      body: {
        context: contextOf(draft),
        testSet: { testSetId, testSetName: mapping.testSetName, platform: mapping.platform },
        rows: draft.rows,
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparison failed.";
    mutateDraft(draftId, (d) => recordCompareError(d, testSetId, message));
    logActivity({
      type: "compare.failed",
      message: `Comparison failed for test set ${testSetId}: ${message}`,
      draftId,
      module: draft.module,
      details: { testSetId },
    });
    throw error;
  }

  const updated = mutateDraft(draftId, (d) => recordComparison(d, comparison));
  logActivity({
    type: "compare.succeeded",
    message: `Compared ${comparison.testSetName} (${comparison.cards.length} cards).`,
    draftId,
    module: draft.module,
    details: { testSetId, cards: comparison.cards.length },
  });
  return updated;
}

async function checkMembership(draft: Draft): Promise<PreflightResult> {
  const { preflight } = await api<{ preflight: PreflightResult }>("/api/workflow/preflight", {
    method: "POST",
    body: {
      context: contextOf(draft),
      testSets: draft.testSets,
      decisions: draft.decisions,
      removed: draft.apply.removed,
    },
  });
  return preflight;
}

/**
 * Reads membership from Spira (read only) and brings the draft up to date with it: Out of Scope cases
 * already gone from Spira are counted as removed. Then checks membership again for the remaining work.
 */
export async function syncWithSpira(draftId: string): Promise<{ draft: Draft; preflight: PreflightResult; adopted: number }> {
  const first = await checkMembership(getDraft(draftId));
  let adopted = 0;
  const synced = mutateDraft(draftId, (d) => {
    adopted = adoptSpiraRemovals(d, first);
    if (!adopted) recordPreflight(d, first);
  });
  if (!adopted) return { draft: synced, preflight: first, adopted };
  logActivity({
    type: "apply.synced",
    message: `Spira check: ${adopted} Out of Scope case${adopted === 1 ? " was" : "s were"} already removed in Spira and ${adopted === 1 ? "is" : "are"} now counted as removed.`,
    draftId,
    module: synced.module,
    details: { adopted },
  });
  const out = await runPreflight(draftId);
  return { ...out, adopted };
}

export async function runPreflight(draftId: string): Promise<{ draft: Draft; preflight: PreflightResult }> {
  const preflight = await checkMembership(getDraft(draftId));
  const updated = mutateDraft(draftId, (d) => recordPreflight(d, preflight));
  logActivity({
    type: preflight.ok ? "preflight.passed" : "preflight.blocked",
    message: preflight.ok
      ? "Membership check passed: Spira matches the reviewed baseline."
      : "Membership check blocked apply: Spira changed since the comparison.",
    draftId,
    module: updated.module,
    details: {
      sets: preflight.sets.map(({ testSetId, ok, unexpected, missing, error }) => ({
        testSetId,
        ok,
        unexpected: unexpected.length,
        missing: missing.length,
        error,
      })),
    },
  });
  return { draft: updated, preflight };
}

export async function applyBatch(
  draftId: string,
  batch: ApplyBatchInput,
): Promise<{ draft: Draft; results: ApplyActionResult[] }> {
  const draft = getDraft(draftId);
  const { results } = await api<{ results: ApplyActionResult[] }>("/api/workflow/apply", {
    method: "POST",
    body: {
      context: contextOf(draft),
      testSets: draft.testSets,
      decisions: draft.decisions,
      removed: draft.apply.removed,
      preflight: draft.apply.preflight,
      batch,
    },
  });
  const updated = mutateDraft(draftId, (d) => recordApplyResults(d, batch, results));

  const failed = results.filter((r) => r.status === "failed");
  logActivity({
    type: batch.dryRun ? "apply.dryRun" : failed.length ? "apply.batchWithErrors" : "apply.batch",
    message: `${batch.dryRun ? "Dry run" : "Live apply"} for test set ${batch.testSetId}: ${results.length - failed.length} ok, ${failed.length} failed.`,
    draftId,
    module: draft.module,
    details: {
      testSetId: batch.testSetId,
      dryRun: batch.dryRun,
      failed: failed.map((r) => r.testSetTestCaseId),
    },
  });
  return { draft: updated, results };
}

/**
 * Decides whether each candidate is really blocked. With AI on, the server asks Gemini, reading the test
 * scenario only; keyword matches it could not answer, or every match when AI is off, fall back to the keyword
 * verdict. Deep-check candidates (no keyword in the scenario) only ever get an AI verdict.
 */
export async function reviewBlockedCases(
  draftId: string,
  candidates: BlockedCandidate[],
  useAi: boolean,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ draft: Draft; aiError: string | null; stopped: boolean }> {
  const draft = getDraft(draftId);
  const at = new Date().toISOString();
  const assessments: Record<string, BlockedAssessment> = {};
  let aiError: string | null = null;
  let stopped = false;
  if (useAi) {
    let done = 0;
    for (const batch of chunk(candidates, MAX_AI_REVIEW_BATCH)) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      try {
        const { verdicts } = await api<{ verdicts: AiBlockedVerdict[] }>("/api/ai/blocked-review", {
          method: "POST",
          signal,
          body: {
            module: draft.module,
            cases: batch.map(({ card, keywords }) => ({
              key: card.key,
              testSetName: draft.testSets.find((s) => s.testSetId === card.testSetId)?.testSetName ?? `TX${card.testSetId}`,
              scenario: card.name,
              ...(card.workbookScenario ? { workbookScenario: card.workbookScenario } : {}),
              keywords,
              allKeywords: draft.testSetKeywords?.[String(card.testSetId)] ?? keywords,
            })),
          },
        });
        const byKey = new Map(batch.map((c) => [c.card.key, c]));
        for (const v of verdicts) {
          const candidate = byKey.get(v.key);
          if (!candidate) continue;
          assessments[v.key] = {
            keywords: candidate.keywords,
            blocked: v.blocked,
            confidence: v.confidence,
            reason: v.reason,
            source: "ai",
            at,
            features: v.features,
            against: draft.testSetKeywords?.[String(candidate.card.testSetId)] ?? [],
          };
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") stopped = true;
        else aiError = errorMessage(err);
        break;
      }
      mutateDraft(draftId, (d) => recordBlockedReview(d, assessments, at));
      done += batch.length;
      onProgress?.(done, candidates.length);
    }
  }
  for (const c of candidates) if (c.keywords.length) assessments[c.card.key] ??= keywordAssessment(c.keywords, at);
  return { draft: mutateDraft(draftId, (d) => recordBlockedReview(d, assessments, at)), aiError, stopped };
}

export async function signOffBatch(
  draftId: string,
  batch: SignOffBatchInput,
  notes: Record<string, string>,
): Promise<{ draft: Draft; results: SignOffResult[] }> {
  const draft = getDraft(draftId);
  const { results } = await api<{ results: SignOffResult[] }>("/api/workflow/sign-off", {
    method: "POST",
    body: {
      context: contextOf(draft),
      testSets: draft.testSets,
      decisions: draft.decisions,
      removed: draft.apply.removed,
      preflight: draft.apply.preflight,
      draftName: draft.name,
      notes,
      batch,
    },
  });
  const updated = mutateDraft(draftId, (d) => recordSignOffResults(d, batch.dryRun, results));
  const count = (outcome: SignOffResult["result"]) => results.filter((r) => r.result === outcome).length;
  const label = batch.status === "blocked" ? "Blocked" : "Passed";
  logActivity({
    type: batch.dryRun ? "signOff.dryRun" : count("failed") ? "signOff.batchWithErrors" : "signOff.batch",
    message: batch.dryRun
      ? `Dry run: ${count("wouldRecord")} ${label} result(s) would be recorded for test set ${batch.testSetId}, ${count("skipped")} skipped.`
      : `Recorded ${count("recorded")} ${label} result(s) for test set ${batch.testSetId}; ${count("skipped")} skipped, ${count("failed")} failed.`,
    draftId,
    module: draft.module,
    details: {
      testSetId: batch.testSetId,
      status: batch.status,
      dryRun: batch.dryRun,
      testRunIds: results.flatMap((r) => (r.testRunId ? [r.testRunId] : [])),
      failed: results.filter((r) => r.result === "failed").map((r) => r.testSetTestCaseId),
    },
  });
  return { draft: updated, results };
}

/** Deletes runs this app recorded, in batches, and forgets the ones that are gone. */
export async function undoSignOff(
  draftId: string,
  runs: SignOffRun[],
): Promise<{ draft: Draft; failed: { testRunId: number; message: string | null }[] }> {
  const draft = getDraft(draftId);
  const deleted: number[] = [];
  const failed: { testRunId: number; message: string | null }[] = [];
  let updated = draft;
  for (const batch of chunk(runs, MAX_APPLY_BATCH)) {
    const { results } = await api<{ results: { testRunId: number; ok: boolean; message: string | null }[] }>(
      "/api/workflow/undo-sign-off",
      { method: "POST", body: { context: contextOf(draft), runs: batch.map(({ testRunId, testCaseId }) => ({ testRunId, testCaseId })) } },
    );
    const ok = results.filter((r) => r.ok).map((r) => r.testRunId);
    deleted.push(...ok);
    failed.push(...results.filter((r) => !r.ok));
    updated = mutateDraft(draftId, (d) => recordSignOffUndo(d, ok));
  }
  logActivity({
    type: failed.length ? "signOff.undoWithErrors" : "signOff.undo",
    message: `Undo sign-off: deleted ${deleted.length} test run(s) from Spira${failed.length ? `, ${failed.length} could not be deleted` : ""}.`,
    draftId,
    module: draft.module,
    details: { deleted, failed: failed.map((f) => f.testRunId) },
  });
  return { draft: updated, failed };
}

export interface CompletionCheck {
  draft: Draft;
  completed: boolean;
  /** Why the draft did not complete; null when it did. */
  reason: string | null;
}

/** What a failed check found, in words. */
function differences(verification: VerificationResult, draft: Draft): string {
  const name = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `Test set ${id}`;
  const parts = verification.sets
    .filter((s) => !s.ok)
    .map((s) =>
      s.error
        ? `${name(s.testSetId)} could not be read (${s.error})`
        : [
            s.stillPresent.length && `${s.stillPresent.length} case${s.stillPresent.length === 1 ? "" : "s"} added in Spira`,
            s.unexpectedlyRemoved.length && `${s.unexpectedlyRemoved.length} removed in Spira`,
          ]
            .filter(Boolean)
            .map((p) => `${name(s.testSetId)}: ${p}`)
            .join("; "),
    );
  return parts.join("; ") || "Spira does not match the board.";
}

/**
 * Completes a draft that has nothing to change in Spira (every test set compared, nothing in Needs
 * Review, nothing left to remove) once a read-only check finds Spira's test sets still match the board.
 * Nothing is written to Spira. A draft with work left, or whose test sets changed in Spira since the
 * comparison, stays a draft and the reason is returned.
 */
export async function completeWithoutChanges(draftId: string): Promise<CompletionCheck> {
  const draft = getDraft(draftId);
  const blocker = completionBlocker(draft);
  if (blocker) return { draft, completed: false, reason: blocker };
  const { verification } = await api<{ verification: VerificationResult }>("/api/workflow/verify", {
    method: "POST",
    body: { context: contextOf(draft), testSets: draft.testSets, decisions: draft.decisions },
  });
  // The board may have changed while Spira was being read.
  const latest = getDraft(draftId);
  const stillReady = completionBlocker(latest);
  const completed = !stillReady && verification.ok;
  const updated = completed ? mutateDraft(draftId, (d) => void recordCleanCompletion(d, verification)) : latest;
  const reason = completed
    ? null
    : (stillReady ?? `Spira changed since the comparison: ${differences(verification, updated)}. Recompare the board.`);
  const counts = countColumns(allCards(updated.testSets), updated.decisions);
  logActivity({
    type: completed ? "draft.completedWithoutChanges" : "draft.completionCheckFailed",
    message: completed
      ? `Completed without a live apply: nothing to remove, and Spira matches the board (${counts.inScope + counts.defects} In Scope${counts.blocked ? `, ${counts.blocked} Blocked` : ""}).`
      : `Not completed: ${reason}`,
    draftId,
    module: updated.module,
    details: { sets: verification.sets.map(({ testSetId, ok, stillPresent, unexpectedlyRemoved, error }) => ({ testSetId, ok, added: stillPresent.length, removed: unexpectedlyRemoved.length, error })) },
  });
  return { draft: updated, completed, reason };
}

export async function verifyApply(draftId: string): Promise<{ draft: Draft; verification: VerificationResult }> {
  const draft = getDraft(draftId);
  if (!draft.apply.lastLiveRunAt) throw new Error("Nothing to verify: no live apply has run for this draft.");
  const { verification } = await api<{ verification: VerificationResult }>("/api/workflow/verify", {
    method: "POST",
    body: {
      context: contextOf(draft),
      testSets: draft.testSets,
      decisions: draft.decisions,
    },
  });
  const updated = mutateDraft(draftId, (d) => recordVerification(d, verification));
  logActivity({
    type: verification.ok ? "verify.applied" : "verify.appliedWithErrors",
    message: verification.ok
      ? "Verified: Spira membership now matches the reviewed board."
      : "Verification found differences between Spira and the reviewed board.",
    draftId,
    module: draft.module,
    details: {
      sets: verification.sets.map(({ testSetId, ok, stillPresent, unexpectedlyRemoved, error }) => ({
        testSetId,
        ok,
        stillPresent: stillPresent.length,
        unexpectedlyRemoved: unexpectedlyRemoved.length,
        error,
      })),
    },
  });
  return { draft: updated, verification };
}
