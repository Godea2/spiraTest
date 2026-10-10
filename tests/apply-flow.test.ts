import { describe, expect, it } from "vitest";
import { allCards, chunk, removalActions, summarizeDraft } from "@/lib/domain/board";
import { createDraft, getDraft, listDrafts, mutateDraft } from "@/lib/server/draft-store";
import { mockRemoveMembership } from "@/lib/server/mock";
import {
  applyBatch,
  ApplyValidationError,
  compareTestSet,
  runPreflight,
  validateApplyBatch,
  verifyApply,
} from "@/lib/server/reconciler";

async function comparedDraft() {
  const draft = await createDraft({
    name: "Onboarding iOS",
    module: "Onboarding",
    projectId: 24,
    releaseId: 157,
    releaseLabel: "1.0.0.0.0002 - Sprint3",
    source: { fileName: "plan.xlsx", inScopeSheet: "Phase 1 In-Scope", needsConfirmationSheet: null },
    rows: [],
    testSetIds: [125],
  });
  return compareTestSet(draft.id, 125);
}

async function resolveNeedsReview(id: string) {
  return mutateDraft(id, (d) => {
    for (const card of allCards(d.testSets)) {
      if (card.suggestion === "needsReview") d.decisions[card.key] = "inScope";
    }
  });
}

async function liveApplyAll(id: string) {
  const draft = await getDraft(id);
  const set = draft.testSets[0];
  const batches = chunk(removalActions(set, draft.decisions), 25);
  const results = [];
  for (const actions of batches) {
    const out = await applyBatch(id, { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions });
    results.push(...out.results);
  }
  return results;
}

describe("draft persistence", () => {
  it("persists counts and status in the summary", async () => {
    const draft = await comparedDraft();
    const [summary] = await listDrafts();
    expect(summary.id).toBe(draft.id);
    expect(summary.complete).toBe(true);
    expect(summary.status).toBe("draft");
    expect(summary.counts).toEqual({ inScope: 142, outOfScope: 64, needsReview: 5, total: 211 });
    expect(summary.missingFromSpira).toBe(2);
  });

  it("rejects stale writes with optimistic concurrency", async () => {
    const draft = await comparedDraft();
    await mutateDraft(draft.id, (d) => void (d.name = "first"), draft.updatedAt);
    await expect(mutateDraft(draft.id, (d) => void (d.name = "second"), draft.updatedAt)).rejects.toThrow(
      /changed elsewhere/,
    );
  });

  it("recompare preserves manual decisions for cards still present", async () => {
    const draft = await comparedDraft();
    const key = draft.testSets[0].cards[0].key;
    await mutateDraft(draft.id, (d) => void (d.decisions[key] = "needsReview"));
    const recompared = await compareTestSet(draft.id, 125);
    expect(recompared.decisions[key]).toBe("needsReview");
    expect(recompared.history.at(-1)?.label).toMatch(/Recompared/);
  });
});

describe("remove-only validation", () => {
  it("accepts suggested Out of Scope cards the user never moved", async () => {
    const draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 3);
    expect(() => validateApplyBatch(draft, { testSetId: 125, dryRun: true, actions })).not.toThrow();
  });

  it("rejects In Scope cards and mismatched case IDs", async () => {
    const draft = await comparedDraft();
    const inScope = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    expect(() =>
      validateApplyBatch(draft, {
        testSetId: 125,
        dryRun: true,
        actions: [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }],
      }),
    ).toThrow(ApplyValidationError);
    const out = removalActions(draft.testSets[0], {})[0];
    expect(() =>
      validateApplyBatch(draft, {
        testSetId: 125,
        dryRun: true,
        actions: [{ testCaseId: out.testCaseId + 1, testSetTestCaseId: out.testSetTestCaseId }],
      }),
    ).toThrow(/not an Out of Scope card/);
  });

  it("rejects batches over 25 and duplicates", async () => {
    const draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], {});
    expect(() => validateApplyBatch(draft, { testSetId: 125, dryRun: true, actions: actions.slice(0, 26) })).toThrow(
      /at most 25/,
    );
    expect(() =>
      validateApplyBatch(draft, { testSetId: 125, dryRun: true, actions: [actions[0], actions[0]] }),
    ).toThrow(/twice/);
  });

  it("live apply requires the exact uppercase module, no Needs Review, and a passing preflight", async () => {
    let draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], {}).slice(0, 1);
    const live = { testSetId: 125, dryRun: false, actions };
    expect(() => validateApplyBatch(draft, { ...live, confirmModule: "Onboarding" })).toThrow(/ONBOARDING/);
    expect(() => validateApplyBatch(draft, { ...live, confirmModule: "ONBOARDING" })).toThrow(/Needs Review/);
    draft = await resolveNeedsReview(draft.id);
    expect(() => validateApplyBatch(draft, { ...live, confirmModule: "ONBOARDING" })).toThrow(/membership check/);
    draft = (await runPreflight(draft.id)).draft;
    expect(() => validateApplyBatch(draft, { ...live, confirmModule: "ONBOARDING" })).not.toThrow();
    const later = Date.now() + 16 * 60 * 1000;
    expect(() => validateApplyBatch(draft, { ...live, confirmModule: "ONBOARDING" }, later)).toThrow(/15 minutes/);
  });
});

describe("stale-membership protection", () => {
  it("blocks live apply when Spira membership changed after the comparison", async () => {
    const draft = await resolveNeedsReview((await comparedDraft()).id);
    const someone = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    await mockRemoveMembership(125, [someone.testSetTestCaseId]);

    const { preflight } = await runPreflight(draft.id);
    expect(preflight.ok).toBe(false);
    expect(preflight.sets[0].missing).toEqual([someone.testSetTestCaseId]);

    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 1);
    await expect(
      applyBatch(draft.id, { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions }),
    ).rejects.toThrow(/membership check/);
  });
});

describe("live apply with failed-only retry", () => {
  it("removes in batches, retries only the failed case, and verifies as applied", async () => {
    const draft = await resolveNeedsReview((await comparedDraft()).id);
    await runPreflight(draft.id);

    const first = await liveApplyAll(draft.id);
    const failed = first.filter((r) => r.status === "failed");
    expect(first).toHaveLength(64);
    expect(failed.map((r) => r.testCaseId)).toEqual([3661]);

    const partial = await verifyApply(draft.id);
    expect(partial.draft.status).toBe("appliedWithErrors");
    expect(partial.verification.sets[0].stillPresent).toHaveLength(1);

    const resent = await applyBatch(draft.id, {
      testSetId: 125,
      dryRun: false,
      confirmModule: "ONBOARDING",
      actions: failed.map(({ testCaseId, testSetTestCaseId }) => ({ testCaseId, testSetTestCaseId })),
    });
    expect(resent.results.map((r) => r.status)).toEqual(["removed"]);

    const done = await verifyApply(draft.id);
    expect(done.verification.ok).toBe(true);
    expect(done.draft.status).toBe("applied");
    expect(summarizeDraft(done.draft).status).toBe("applied");
  });

  it("never re-sends actions that already succeeded", async () => {
    const draft = await resolveNeedsReview((await comparedDraft()).id);
    await runPreflight(draft.id);
    const action = removalActions(draft.testSets[0], draft.decisions).find((a) => a.testCaseId !== 3661)!;
    const live = { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions: [action] };
    expect((await applyBatch(draft.id, live)).results[0].status).toBe("removed");
    const again = await applyBatch(draft.id, live);
    expect(again.results[0]).toMatchObject({ status: "skipped", message: "Already removed in an earlier run." });
  });

  it("dry run changes nothing and does not need the live safeguards", async () => {
    const draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 25);
    const { results } = await applyBatch(draft.id, { testSetId: 125, dryRun: true, actions });
    expect(results.every((r) => r.status === "wouldRemove")).toBe(true);
    const { preflight } = await runPreflight(draft.id);
    expect(preflight.ok).toBe(true);
  });
});
