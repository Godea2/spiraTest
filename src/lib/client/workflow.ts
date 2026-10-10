import type { ApplyBatchInput } from "@/lib/domain/apply-rules";
import {
  recordApplyResults,
  recordCompareError,
  recordComparison,
  recordPreflight,
  recordVerification,
} from "@/lib/domain/draft-ops";
import type {
  ApplyActionResult,
  Draft,
  PreflightResult,
  TestSetComparison,
  TestSetMapping,
  VerificationResult,
  WorkflowContext,
} from "@/lib/domain/types";
import { logActivity } from "./activity";
import { api } from "./api";
import { getDraft, mutateDraft } from "./drafts";

// The server is stateless: each call carries the board it acts on and the draft
// in this browser is updated with the result.

const contextOf = (draft: Draft): WorkflowContext => ({
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

export async function runPreflight(draftId: string): Promise<{ draft: Draft; preflight: PreflightResult }> {
  const draft = getDraft(draftId);
  const { preflight } = await api<{ preflight: PreflightResult }>("/api/workflow/preflight", {
    method: "POST",
    body: {
      context: contextOf(draft),
      testSets: draft.testSets,
      decisions: draft.decisions,
      removed: draft.apply.removed,
    },
  });
  const updated = mutateDraft(draftId, (d) => recordPreflight(d, preflight));
  logActivity({
    type: preflight.ok ? "preflight.passed" : "preflight.blocked",
    message: preflight.ok
      ? "Membership check passed: Spira matches the reviewed baseline."
      : "Membership check blocked apply: Spira changed since the comparison.",
    draftId,
    module: draft.module,
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
