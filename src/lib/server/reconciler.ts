import "server-only";
import {
  allCards,
  diffMembership,
  effectiveColumn,
  intendedMembership,
  MAX_APPLY_BATCH,
  preserveDecisions,
} from "@/lib/domain/board";
import type {
  ApplyAction,
  ApplyActionResult,
  Draft,
  PreflightResult,
  TestSetComparison,
  VerificationResult,
} from "@/lib/domain/types";
import { logActivity } from "./activity-store";
import { getDraft, mutateDraft } from "./draft-store";
import { mockApply, mockReconcile, type ReconcileOutput } from "./mock";
import { AutomationError, n8nApply, n8nReconcile } from "./n8n";
import { getSettings, type StoredSettings } from "./settings-store";

export const PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

export class ApplyValidationError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function mappingFor(settings: StoredSettings, draft: Draft, testSetId: number) {
  const mapping = settings.mappings.find(
    (m) => m.testSetId === testSetId && m.module === draft.module,
  );
  if (!mapping) {
    throw new ApplyValidationError(
      `Test set ${testSetId} is not mapped to ${draft.module} in Settings.`,
      400,
    );
  }
  return mapping;
}

async function reconcileSet(
  settings: StoredSettings,
  draft: Draft,
  testSetId: number,
): Promise<ReconcileOutput & { testSetName: string; platform: TestSetComparison["platform"] }> {
  const mapping = mappingFor(settings, draft, testSetId);
  const output = settings.mockMode
    ? await mockReconcile(testSetId, draft.module)
    : await n8nReconcile(settings.endpoints.reconcileUrl, {
        projectId: draft.projectId,
        releaseId: draft.releaseId,
        module: draft.module,
        testSetId,
        testSetName: mapping.testSetName,
        platform: mapping.platform,
        rows: draft.rows,
      });
  return { ...output, testSetName: mapping.testSetName, platform: mapping.platform };
}

/** Compares one test set and stores the result in the draft, preserving manual decisions. */
export async function compareTestSet(draftId: string, testSetId: number): Promise<Draft> {
  const settings = await getSettings();
  const draft = await getDraft(draftId);
  if (!draft.testSetIds.includes(testSetId)) {
    throw new ApplyValidationError(`Test set ${testSetId} is not part of this draft.`);
  }
  let output: Awaited<ReturnType<typeof reconcileSet>>;
  try {
    output = await reconcileSet(settings, draft, testSetId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparison failed.";
    await mutateDraft(draftId, (d) => {
      d.compareErrors[String(testSetId)] = message;
    });
    await logActivity({
      type: "compare.failed",
      message: `Comparison failed for test set ${testSetId}: ${message}`,
      draftId,
      module: draft.module,
      details: { testSetId, mock: settings.mockMode },
    });
    throw error;
  }

  const comparison: TestSetComparison = {
    testSetId,
    testSetName: output.testSetName,
    platform: output.platform,
    comparedAt: new Date().toISOString(),
    cards: output.cards,
    missingFromSpira: output.missingFromSpira,
    baselineMembership: [...output.membership].sort((a, b) => a - b),
  };

  const updated = await mutateDraft(draftId, (d) => {
    const isRecompare = d.testSets.some((set) => set.testSetId === testSetId);
    d.testSets = [...d.testSets.filter((set) => set.testSetId !== testSetId), comparison].sort(
      (a, b) => d.testSetIds.indexOf(a.testSetId) - d.testSetIds.indexOf(b.testSetId),
    );
    delete d.compareErrors[String(testSetId)];
    d.decisions = preserveDecisions(d.decisions, allCards(d.testSets));
    d.apply.preflight = null;
    if (isRecompare) {
      d.history.push({ at: comparison.comparedAt, label: `Recompared ${comparison.testSetName}`, changes: [] });
    }
  });
  await logActivity({
    type: "compare.succeeded",
    message: `Compared ${comparison.testSetName} (${comparison.cards.length} cards)${settings.mockMode ? " in Mock mode" : ""}.`,
    draftId,
    module: draft.module,
    details: { testSetId, cards: comparison.cards.length, mock: settings.mockMode },
  });
  return updated;
}

/** Freshly reconciles every set and checks membership still matches the reviewed baseline. */
export async function runPreflight(draftId: string): Promise<{ draft: Draft; preflight: PreflightResult }> {
  const settings = await getSettings();
  const draft = await getDraft(draftId);
  const sets = await Promise.all(
    draft.testSets.map(async (set) => {
      const alreadyRemoved = new Set(draft.apply.removed[String(set.testSetId)] ?? []);
      const expected = set.baselineMembership.filter((id) => !alreadyRemoved.has(id));
      try {
        const fresh = await reconcileSet(settings, draft, set.testSetId);
        const diff = diffMembership(expected, fresh.membership);
        return {
          testSetId: set.testSetId,
          ok: diff.unexpected.length === 0 && diff.missing.length === 0,
          ...diff,
        };
      } catch (error) {
        return {
          testSetId: set.testSetId,
          ok: false,
          unexpected: [],
          missing: [],
          error: error instanceof Error ? error.message : "Reconciliation failed.",
        };
      }
    }),
  );
  const preflight: PreflightResult = {
    at: new Date().toISOString(),
    ok: sets.length > 0 && sets.every((s) => s.ok),
    sets,
  };
  const updated = await mutateDraft(draftId, (d) => {
    d.apply.preflight = preflight;
  });
  await logActivity({
    type: preflight.ok ? "preflight.passed" : "preflight.blocked",
    message: preflight.ok
      ? "Membership check passed: Spira matches the reviewed baseline."
      : "Membership check blocked apply: Spira changed since the comparison.",
    draftId,
    module: draft.module,
    details: { sets: sets.map(({ testSetId, ok, unexpected, missing, error }) => ({ testSetId, ok, unexpected: unexpected.length, missing: missing.length, error })) },
  });
  return { draft: updated, preflight };
}

export interface ApplyBatchInput {
  testSetId: number;
  dryRun: boolean;
  confirmModule?: string;
  actions: ApplyAction[];
}

/**
 * Remove-only, batched apply. Every action must correspond to a card that is
 * currently Out of Scope in the saved draft (manually moved or suggested).
 */
export function validateApplyBatch(draft: Draft, input: ApplyBatchInput, now = Date.now()): void {
  if (input.actions.length === 0) throw new ApplyValidationError("No actions to apply.");
  if (input.actions.length > MAX_APPLY_BATCH) {
    throw new ApplyValidationError(`Send at most ${MAX_APPLY_BATCH} actions per batch.`);
  }
  const set = draft.testSets.find((s) => s.testSetId === input.testSetId);
  if (!set) throw new ApplyValidationError(`Test set ${input.testSetId} is not part of this draft.`);

  const outOfScope = new Map(
    set.cards
      .filter((card) => effectiveColumn(card, draft.decisions) === "outOfScope")
      .map((card) => [card.testSetTestCaseId, card]),
  );
  const seen = new Set<number>();
  for (const action of input.actions) {
    if (seen.has(action.testSetTestCaseId)) {
      throw new ApplyValidationError(`Membership ${action.testSetTestCaseId} appears twice in this batch.`);
    }
    seen.add(action.testSetTestCaseId);
    const card = outOfScope.get(action.testSetTestCaseId);
    if (!card || card.testCaseId !== action.testCaseId) {
      throw new ApplyValidationError(
        `Case ${action.testCaseId} (membership ${action.testSetTestCaseId}) is not an Out of Scope card in this draft. Only saved Out of Scope cards can be removed.`,
      );
    }
  }

  if (input.dryRun) return;

  if (input.confirmModule !== draft.module.toUpperCase()) {
    throw new ApplyValidationError(`Type ${draft.module.toUpperCase()} exactly to confirm a live apply.`);
  }
  const needsReview = allCards(draft.testSets).filter(
    (card) => effectiveColumn(card, draft.decisions) === "needsReview",
  ).length;
  if (needsReview > 0) {
    throw new ApplyValidationError(`Resolve the ${needsReview} Needs Review card(s) before a live apply.`);
  }
  const preflight = draft.apply.preflight;
  if (!preflight || !preflight.ok) {
    throw new ApplyValidationError("Run the membership check first; live apply is blocked until it passes.", 409);
  }
  if (now - Date.parse(preflight.at) > PREFLIGHT_MAX_AGE_MS) {
    throw new ApplyValidationError("The membership check is more than 15 minutes old. Run it again.", 409);
  }
}

export async function applyBatch(
  draftId: string,
  input: ApplyBatchInput,
): Promise<{ results: ApplyActionResult[]; draft: Draft }> {
  const settings = await getSettings();
  const draft = await getDraft(draftId);
  validateApplyBatch(draft, input);

  const key = String(input.testSetId);
  const alreadyRemoved = new Set(draft.apply.removed[key] ?? []);
  const skipped: ApplyActionResult[] = [];
  const toSend = input.actions.filter((action) => {
    if (!input.dryRun && alreadyRemoved.has(action.testSetTestCaseId)) {
      skipped.push({ ...action, status: "skipped", message: "Already removed in an earlier run." });
      return false;
    }
    return true;
  });

  let sent: ApplyActionResult[] = [];
  if (toSend.length > 0) {
    try {
      sent = settings.mockMode
        ? await mockApply(input.testSetId, toSend, input.dryRun)
        : await n8nApply(settings.endpoints.applyUrl, {
            projectId: draft.projectId,
            releaseId: draft.releaseId,
            testSetId: input.testSetId,
            dryRun: input.dryRun,
            actions: toSend,
          });
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      sent = toSend.map((action) => ({ ...action, status: "failed", message: error.message }));
    }
  }
  const results = [...skipped, ...sent];

  const updated = await mutateDraft(draftId, (d) => {
    const now = new Date().toISOString();
    if (input.dryRun) {
      d.apply.lastDryRunAt = now;
      return;
    }
    d.apply.lastLiveRunAt = now;
    const removed = new Set(d.apply.removed[key] ?? []);
    const failed = new Set(d.apply.failed[key] ?? []);
    for (const result of results) {
      if (result.status === "removed" || result.status === "skipped") {
        removed.add(result.testSetTestCaseId);
        failed.delete(result.testSetTestCaseId);
      } else if (result.status === "failed") {
        failed.add(result.testSetTestCaseId);
      }
    }
    d.apply.removed[key] = [...removed].sort((a, b) => a - b);
    d.apply.failed[key] = [...failed].sort((a, b) => a - b);
  });

  const failures = results.filter((r) => r.status === "failed").length;
  await logActivity({
    type: input.dryRun ? "apply.dryRun" : failures ? "apply.batchWithErrors" : "apply.batch",
    message: `${input.dryRun ? "Dry run" : "Live apply"} for test set ${input.testSetId}: ${results.length - failures} ok, ${failures} failed${settings.mockMode ? " (Mock mode)" : ""}.`,
    draftId,
    module: draft.module,
    details: {
      testSetId: input.testSetId,
      dryRun: input.dryRun,
      mock: settings.mockMode,
      failed: results.filter((r) => r.status === "failed").map((r) => r.testSetTestCaseId),
    },
  });
  return { results, draft: updated };
}

/** Reconciles again after live apply and compares final membership with the intended membership. */
export async function verifyApply(
  draftId: string,
): Promise<{ draft: Draft; verification: VerificationResult }> {
  const settings = await getSettings();
  const draft = await getDraft(draftId);
  if (!draft.apply.lastLiveRunAt) {
    throw new ApplyValidationError("Nothing to verify: no live apply has run for this draft.");
  }
  const sets = await Promise.all(
    draft.testSets.map(async (set) => {
      const intended = intendedMembership(set, draft.decisions);
      try {
        const fresh = await reconcileSet(settings, draft, set.testSetId);
        const diff = diffMembership(intended, fresh.membership);
        return {
          testSetId: set.testSetId,
          ok: diff.unexpected.length === 0 && diff.missing.length === 0,
          stillPresent: diff.unexpected,
          unexpectedlyRemoved: diff.missing,
        };
      } catch (error) {
        return {
          testSetId: set.testSetId,
          ok: false,
          stillPresent: [],
          unexpectedlyRemoved: [],
          error: error instanceof Error ? error.message : "Reconciliation failed.",
        };
      }
    }),
  );
  const verification: VerificationResult = {
    at: new Date().toISOString(),
    ok: sets.every((s) => s.ok),
    sets,
  };
  const updated = await mutateDraft(draftId, (d) => {
    d.apply.verification = verification;
    d.status = verification.ok ? "applied" : "appliedWithErrors";
  });
  await logActivity({
    type: verification.ok ? "verify.applied" : "verify.appliedWithErrors",
    message: verification.ok
      ? "Verified: Spira membership now matches the reviewed board."
      : "Verification found differences between Spira and the reviewed board.",
    draftId,
    module: draft.module,
    details: { sets: sets.map(({ testSetId, ok, stillPresent, unexpectedlyRemoved, error }) => ({ testSetId, ok, stillPresent: stillPresent.length, unexpectedlyRemoved: unexpectedlyRemoved.length, error })) },
  });
  return { draft: updated, verification };
}
