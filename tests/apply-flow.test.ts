import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { createDraft, getDraft, listDrafts, mutateDraft } from "@/lib/client/drafts";
import { loadMockState, saveMockState } from "@/lib/client/mock-state";
import { applyBatch, compareTestSet, runPreflight, verifyApply } from "@/lib/client/workflow";
import { validateApplyBatch } from "@/lib/domain/apply-rules";
import { allCards, chunk, removalActions, summarizeDraft } from "@/lib/domain/board";
import { recordBoardEdits } from "@/lib/domain/draft-ops";
import { defaultSettings } from "@/lib/domain/settings";
import { NO_OVERRIDES } from "@/lib/server/endpoint-overrides";
import {
  applyRequestSchema,
  preflightRequestSchema,
  reconcileSchema,
  verifyRequestSchema,
} from "@/lib/server/schemas";
import * as server from "@/lib/server/workflow";

// Routes the browser workflow's fetch calls straight into the server workflow, through
// the same request schemas the API routes use.
const routes: Record<string, (body: unknown) => Promise<unknown>> = {
  "/api/workflow/reconcile": (b) => server.reconcileTestSet(reconcileSchema.parse(b), NO_OVERRIDES),
  "/api/workflow/preflight": (b) => server.runPreflight(preflightRequestSchema.parse(b), NO_OVERRIDES),
  "/api/workflow/apply": (b) => server.applyBatch(applyRequestSchema.parse(b), NO_OVERRIDES),
  "/api/workflow/verify": (b) => server.verifyApply(verifyRequestSchema.parse(b), NO_OVERRIDES),
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      try {
        return Response.json(await routes[path](JSON.parse(String(init.body))));
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return Response.json({ error: (error as Error).message }, { status });
      }
    }),
  );
});

const mappings = defaultSettings().mappings;

async function comparedDraft() {
  const draft = createDraft({
    name: "Onboarding iOS",
    module: "Onboarding",
    projectId: 24,
    releaseId: 157,
    releaseLabel: "1.0.0.0.0002 - Sprint3",
    mock: true,
    source: { fileName: "plan.xlsx", inScopeSheet: "Phase 1 In-Scope", needsConfirmationSheet: null },
    rows: [],
    testSetIds: [125],
  });
  return compareTestSet(draft.id, 125, mappings);
}

function resolveNeedsReview(id: string) {
  return mutateDraft(id, (d) => {
    const decisions = { ...d.decisions };
    for (const card of allCards(d.testSets)) if (card.suggestion === "needsReview") decisions[card.key] = "inScope";
    recordBoardEdits(d, { decisions });
  });
}

async function liveApplyAll(id: string) {
  const draft = getDraft(id);
  const results = [];
  for (const actions of chunk(removalActions(draft.testSets[0], draft.decisions), 25)) {
    results.push(...(await applyBatch(id, { testSetId: 125, dryRun: false, confirmModule: "ONBOARDING", actions })).results);
  }
  return results;
}

const live = (actions: ReturnType<typeof removalActions>) => ({
  testSetId: 125,
  dryRun: false,
  confirmModule: "ONBOARDING",
  actions,
});

describe("drafts in browser storage", () => {
  it("persists counts and status in the summary", async () => {
    const draft = await comparedDraft();
    const [summary] = listDrafts();
    expect(summary).toMatchObject({ id: draft.id, complete: true, status: "draft", mock: true, missingFromSpira: 2 });
    expect(summary.counts).toEqual({ inScope: 142, outOfScope: 64, needsReview: 5, total: 211 });
  });

  it("rejects stale writes with optimistic concurrency", async () => {
    const draft = await comparedDraft();
    mutateDraft(draft.id, (d) => void (d.name = "first"), draft.updatedAt);
    expect(() => mutateDraft(draft.id, (d) => void (d.name = "second"), draft.updatedAt)).toThrow(/another tab/);
  });

  it("recompare preserves manual decisions for cards still present", async () => {
    const draft = await comparedDraft();
    const key = draft.testSets[0].cards[0].key;
    mutateDraft(draft.id, (d) => recordBoardEdits(d, { decisions: { [key]: "needsReview" } }));
    const recompared = await compareTestSet(draft.id, 125, mappings);
    expect(recompared.decisions[key]).toBe("needsReview");
    expect(recompared.history.at(-1)?.label).toMatch(/Recompared/);
  });
});

describe("remove-only validation on the server", () => {
  it("accepts suggested Out of Scope cards the user never moved", async () => {
    const draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 3);
    const { results } = await applyBatch(draft.id, { testSetId: 125, dryRun: true, actions });
    expect(results.every((r) => r.status === "wouldRemove")).toBe(true);
  });

  it("rejects In Scope cards and mismatched case IDs", async () => {
    const draft = await comparedDraft();
    const inScope = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    await expect(
      applyBatch(draft.id, {
        testSetId: 125,
        dryRun: true,
        actions: [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }],
      }),
    ).rejects.toThrow(/not an Out of Scope card/);
    const out = removalActions(draft.testSets[0], {})[0];
    await expect(
      applyBatch(draft.id, {
        testSetId: 125,
        dryRun: true,
        actions: [{ testCaseId: out.testCaseId + 1, testSetTestCaseId: out.testSetTestCaseId }],
      }),
    ).rejects.toThrow(/not an Out of Scope card/);
  });

  it("rejects batches over 25 and duplicates", async () => {
    const draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], {});
    await expect(applyBatch(draft.id, { testSetId: 125, dryRun: true, actions: actions.slice(0, 26) })).rejects.toThrow(
      ApiError,
    );
    await expect(
      applyBatch(draft.id, { testSetId: 125, dryRun: true, actions: [actions[0], actions[0]] }),
    ).rejects.toThrow(/twice/);
  });

  it("live apply requires the exact uppercase module, no Needs Review, and a passing membership check", async () => {
    let draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], {}).slice(0, 1);
    await expect(applyBatch(draft.id, { ...live(actions), confirmModule: "Onboarding" })).rejects.toThrow(/ONBOARDING/);
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/Needs Review/);
    draft = resolveNeedsReview(draft.id);
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/membership check/);
    await runPreflight(draft.id);
    expect((await applyBatch(draft.id, live(actions))).results[0].status).toBe("removed");
  });

  it("treats a membership check older than 15 minutes as stale", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    const { preflight } = await runPreflight(draft.id);
    const board = { module: "Onboarding", testSets: draft.testSets, decisions: draft.decisions, preflight };
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 1);
    expect(() => validateApplyBatch(board, live(actions))).not.toThrow();
    expect(() => validateApplyBatch(board, live(actions), Date.now() + 16 * 60 * 1000)).toThrow(/15 minutes/);
  });
});

describe("tamper protection for browser-held drafts", () => {
  it("rejects a comparison whose suggestions were edited in storage", async () => {
    const draft = await comparedDraft();
    const inScope = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    mutateDraft(draft.id, (d) => {
      d.testSets[0].cards.find((c) => c.key === inScope.key)!.suggestion = "outOfScope";
    });
    await expect(
      applyBatch(draft.id, {
        testSetId: 125,
        dryRun: true,
        actions: [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }],
      }),
    ).rejects.toThrow(/could not be verified/);
  });

  it("never lets a Mock mode comparison drive a real apply", async () => {
    const draft = await comparedDraft();
    mutateDraft(draft.id, (d) => void (d.mock = false));
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 1);
    await expect(applyBatch(draft.id, { testSetId: 125, dryRun: true, actions })).rejects.toThrow(/could not be verified/);
  });

  it("binds the membership check to the decisions it was run with", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    await runPreflight(draft.id);
    const inScope = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    // Edit decisions without going through the board, so the stored check is not cleared.
    mutateDraft(draft.id, (d) => void (d.decisions[inScope.key] = "outOfScope"));
    const actions = [{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }];
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/membership check/);
  });

  it("rejects a forged passing membership check", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    mutateDraft(draft.id, (d) => {
      d.apply.preflight = { at: new Date().toISOString(), ok: true, sets: [], seal: "forged" };
    });
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 1);
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/membership check/);
  });

  it("refuses to compare without SESSION_SECRET instead of returning unsigned data", async () => {
    delete process.env.SESSION_SECRET;
    await expect(comparedDraft()).rejects.toMatchObject({ status: 503 });
  });

  it("board edits clear the stored membership check", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    await runPreflight(draft.id);
    const key = draft.testSets[0].cards[0].key;
    const edited = mutateDraft(draft.id, (d) => recordBoardEdits(d, { decisions: { ...d.decisions, [key]: "outOfScope" } }));
    expect(edited.apply.preflight).toBeNull();
  });
});

describe("stale-membership protection", () => {
  it("blocks live apply when Spira membership changed after the comparison", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    const someone = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    saveMockState({ ...loadMockState(), removed: { "125": [someone.testSetTestCaseId] } });

    const { preflight } = await runPreflight(draft.id);
    expect(preflight.ok).toBe(false);
    expect(preflight.seal).toBeNull();
    expect(preflight.sets[0].missing).toEqual([someone.testSetTestCaseId]);

    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 1);
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/membership check/);
  });
});

describe("live apply with failed-only retry", () => {
  it("removes in batches, retries only the failed case, and verifies as applied", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    await runPreflight(draft.id);

    const first = await liveApplyAll(draft.id);
    const failed = first.filter((r) => r.status === "failed");
    expect(first).toHaveLength(64);
    expect(failed.map((r) => r.testCaseId)).toEqual([3661]);

    const partial = await verifyApply(draft.id);
    expect(partial.draft.status).toBe("appliedWithErrors");
    expect(partial.verification.sets[0].stillPresent).toHaveLength(1);

    const resent = await applyBatch(
      draft.id,
      live(failed.map(({ testCaseId, testSetTestCaseId }) => ({ testCaseId, testSetTestCaseId }))),
    );
    expect(resent.results.map((r) => r.status)).toEqual(["removed"]);

    const done = await verifyApply(draft.id);
    expect(done.verification.ok).toBe(true);
    expect(done.draft.status).toBe("applied");
    expect(summarizeDraft(done.draft).status).toBe("applied");
  });

  it("never re-sends actions that already succeeded", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    await runPreflight(draft.id);
    const action = removalActions(draft.testSets[0], draft.decisions).find((a) => a.testCaseId !== 3661)!;
    expect((await applyBatch(draft.id, live([action]))).results[0].status).toBe("removed");
    const again = await applyBatch(draft.id, live([action]));
    expect(again.results[0]).toMatchObject({ status: "skipped", message: "Already removed in an earlier run." });
  });

  it("dry run changes nothing and does not need the live safeguards", async () => {
    const draft = await comparedDraft();
    const actions = removalActions(draft.testSets[0], draft.decisions).slice(0, 25);
    const { results } = await applyBatch(draft.id, { testSetId: 125, dryRun: true, actions });
    expect(results.every((r) => r.status === "wouldRemove")).toBe(true);
    expect(loadMockState().removed).toEqual({});
    const { preflight } = await runPreflight(draft.id);
    expect(preflight.ok).toBe(true);
  });
});
