import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client/api";
import { createDraft, getDraft, listDrafts, mutateDraft, purgeMockData } from "@/lib/client/drafts";
import { readItem, writeItem } from "@/lib/client/storage";
import { applyBatch, compareTestSet, runPreflight, verifyApply } from "@/lib/client/workflow";
import { validateApplyBatch } from "@/lib/domain/apply-rules";
import { allCards, chunk, removalActions, summarizeDraft } from "@/lib/domain/board";
import { recordBoardEdits } from "@/lib/domain/draft-ops";
import { defaultSettings } from "@/lib/domain/settings";
import type { ApplyAction, WorkbookRow } from "@/lib/domain/types";
import {
  applyRequestSchema,
  preflightRequestSchema,
  reconcileSchema,
  verifyRequestSchema,
} from "@/lib/server/schemas";
import * as server from "@/lib/server/workflow";
import { FakeSpira, SPIRA_TEST_ENV, type FakeCase } from "./fake-spira";

// The browser workflow's calls to /api/* are routed straight into the server workflow
// through the same request schemas the API routes use; the server's calls go to FakeSpira.
const routes: Record<string, (body: unknown) => Promise<unknown>> = {
  "/api/workflow/reconcile": (b) => server.reconcileTestSet(reconcileSchema.parse(b)),
  "/api/workflow/preflight": (b) => server.runPreflight(preflightRequestSchema.parse(b)),
  "/api/workflow/apply": (b) => server.applyBatch(applyRequestSchema.parse(b)),
  "/api/workflow/verify": (b) => server.verifyApply(verifyRequestSchema.parse(b)),
};

let spira: FakeSpira;

const pad = (n: number) => String(n).padStart(3, "0");
const row = (n: number, scope: WorkbookRow["scope"] = "inScope"): WorkbookRow => ({
  sheet: scope === "inScope" ? "Phase 1 In-Scope" : "Needs Confirmation",
  rowNumber: n + 1,
  scope,
  values: { "TC ID": `TC-ONB-${pad(n)}`, "Test Scenario": `Verify onboarding step ${n}`, Module: "Onboarding" },
});

/** 30 In-Scope rows and 2 Needs Confirmation rows. */
const ROWS: WorkbookRow[] = [...Array.from({ length: 30 }, (_, i) => row(i + 1)), row(101, "needsConfirmation"), row(102, "needsConfirmation")];

/**
 * Test set 125: 28 cases matching In-Scope rows (by TC ID in the name, by exact scenario,
 * and by TC ID in a custom property), 2 matching Needs Confirmation rows, and 30 legacy
 * cases that are not in the workbook. Rows 29 and 30 have no test case in Spira.
 */
function seedSpira() {
  const cases: FakeCase[] = [];
  let id = 3519;
  for (let n = 1; n <= 26; n += 1) {
    cases.push({ testCaseId: id++, name: `TC-ONB-${pad(n)} - Verify onboarding step ${n}`, executionStatusId: n % 4 === 0 ? 2 : 3 });
  }
  cases.push({ testCaseId: id++, name: "verify onboarding STEP 27!" });
  cases.push({ testCaseId: id++, name: "Biometric prompt appears", customText: ["TC-ONB-028"] });
  cases.push({ testCaseId: id++, name: "TC-ONB-101 Confirm optional step" });
  cases.push({ testCaseId: id++, name: "TC-ONB-102 Confirm another optional step" });
  for (let n = 1; n <= 30; n += 1) {
    cases.push({ testCaseId: id++, name: `Legacy regression check ${n}`, executionStatusId: n % 5 === 0 ? 1 : 3 });
  }
  spira.addTestSet(125, "Onboarding-IOS", cases);
}

beforeEach(() => {
  Object.assign(process.env, SPIRA_TEST_ENV);
  spira = new FakeSpira();
  seedSpira();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      if (!path.startsWith("/api/")) return spira.handle(input, init);
      try {
        return Response.json(await routes[path](JSON.parse(String(init.body))));
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return Response.json({ error: (error as Error).message }, { status });
      }
    }),
  );
});

afterEach(() => {
  for (const key of Object.keys(SPIRA_TEST_ENV)) delete process.env[key];
});

const mappings = defaultSettings().mappings;

async function comparedDraft() {
  const draft = createDraft({
    name: "Onboarding iOS",
    module: "Onboarding",
    projectId: 24,
    releaseId: 157,
    releaseLabel: "1.0.0.0.0002 - Sprint3",
    source: { fileName: "plan.xlsx", inScopeSheet: "Phase 1 In-Scope", needsConfirmationSheet: "Needs Confirmation" },
    rows: ROWS,
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

async function readyForLive() {
  const draft = resolveNeedsReview((await comparedDraft()).id);
  await runPreflight(draft.id);
  return getDraft(draft.id);
}

async function liveApplyAll(id: string) {
  const draft = getDraft(id);
  const results = [];
  for (const actions of chunk(removalActions(draft.testSets[0], draft.decisions), 25)) {
    results.push(...(await applyBatch(id, live(actions))).results);
  }
  return results;
}

const live = (actions: ApplyAction[], confirmModule = "ONBOARDING") => ({ testSetId: 125, dryRun: false, confirmModule, actions });
const dry = (actions: ApplyAction[]) => ({ testSetId: 125, dryRun: true, actions });
const outOfScope = (draftId: string) => {
  const draft = getDraft(draftId);
  return removalActions(draft.testSets[0], draft.decisions);
};

describe("comparing against Spira", () => {
  it("sorts every membership into a column and lists rows missing from Spira", async () => {
    const draft = await comparedDraft();
    const [summary] = listDrafts();
    expect(summary).toMatchObject({ id: draft.id, complete: true, status: "draft", missingFromSpira: 2 });
    expect(summary.counts).toEqual({ inScope: 28, outOfScope: 30, needsReview: 2, total: 60 });
    expect(draft.testSets[0].missingFromSpira.map((m) => m.tcId)).toEqual(["TC-ONB-029", "TC-ONB-030"]);
    expect(draft.testSets[0].baselineMembership).toEqual(spira.members(125));
  });

  it("reads only from Spira while comparing", async () => {
    await comparedDraft();
    expect(spira.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("shows a clear error when Spira is not configured", async () => {
    delete process.env.SPIRA_API_KEY;
    await expect(comparedDraft()).rejects.toThrow(/SPIRA_API_KEY is not set/);
    expect(spira.calls).toHaveLength(0);
    expect(listDrafts()[0].complete).toBe(false);
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
    const { results } = await applyBatch(draft.id, dry(outOfScope(draft.id).slice(0, 3)));
    expect(results.every((r) => r.status === "wouldRemove")).toBe(true);
  });

  it("rejects In Scope cards and mismatched case IDs", async () => {
    const draft = await comparedDraft();
    const inScope = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    await expect(
      applyBatch(draft.id, dry([{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }])),
    ).rejects.toThrow(/not an Out of Scope card/);
    const out = outOfScope(draft.id)[0];
    await expect(
      applyBatch(draft.id, dry([{ testCaseId: out.testCaseId + 1, testSetTestCaseId: out.testSetTestCaseId }])),
    ).rejects.toThrow(/not an Out of Scope card/);
  });

  it("rejects batches over 25 and duplicates", async () => {
    const draft = await comparedDraft();
    const actions = outOfScope(draft.id);
    await expect(applyBatch(draft.id, dry(actions.slice(0, 26)))).rejects.toThrow(ApiError);
    await expect(applyBatch(draft.id, dry([actions[0], actions[0]]))).rejects.toThrow(/twice/);
  });

  it("live apply requires the exact uppercase module, no Needs Review, and a passing membership check", async () => {
    let draft = await comparedDraft();
    const actions = outOfScope(draft.id).slice(0, 1);
    await expect(applyBatch(draft.id, live(actions, "Onboarding"))).rejects.toThrow(/ONBOARDING/);
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/Needs Review/);
    draft = resolveNeedsReview(draft.id);
    await expect(applyBatch(draft.id, live(actions))).rejects.toThrow(/membership check/);
    expect(spira.deletes).toEqual([]);
    await runPreflight(draft.id);
    expect((await applyBatch(draft.id, live(actions))).results[0].status).toBe("removed");
  });

  it("treats a membership check older than 15 minutes as stale", async () => {
    const draft = await readyForLive();
    const board = { module: "Onboarding", testSets: draft.testSets, decisions: draft.decisions, preflight: draft.apply.preflight };
    const actions = outOfScope(draft.id).slice(0, 1);
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
      applyBatch(draft.id, dry([{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }])),
    ).rejects.toThrow(/could not be verified/);
  });

  it("rejects a comparison moved to a different project", async () => {
    const draft = await comparedDraft();
    mutateDraft(draft.id, (d) => void (d.projectId = 99));
    await expect(applyBatch(draft.id, dry(outOfScope(draft.id).slice(0, 1)))).rejects.toThrow(/could not be verified/);
  });

  it("binds the membership check to the decisions it was run with", async () => {
    const draft = await readyForLive();
    const inScope = draft.testSets[0].cards.find((c) => c.suggestion === "inScope")!;
    // Edit decisions without going through the board, so the stored check is not cleared.
    mutateDraft(draft.id, (d) => void (d.decisions[inScope.key] = "outOfScope"));
    await expect(
      applyBatch(draft.id, live([{ testCaseId: inScope.testCaseId, testSetTestCaseId: inScope.testSetTestCaseId }])),
    ).rejects.toThrow(/membership check/);
    expect(spira.deletes).toEqual([]);
  });

  it("rejects a forged passing membership check", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    mutateDraft(draft.id, (d) => {
      d.apply.preflight = { at: new Date().toISOString(), ok: true, sets: [], seal: "forged" };
    });
    await expect(applyBatch(draft.id, live(outOfScope(draft.id).slice(0, 1)))).rejects.toThrow(/membership check/);
  });

  it("refuses to compare without SESSION_SECRET instead of returning unsigned data", async () => {
    delete process.env.SESSION_SECRET;
    await expect(comparedDraft()).rejects.toMatchObject({ status: 503 });
  });

  it("board edits clear the stored membership check", async () => {
    const draft = await readyForLive();
    const key = draft.testSets[0].cards[0].key;
    const edited = mutateDraft(draft.id, (d) => recordBoardEdits(d, { decisions: { ...d.decisions, [key]: "outOfScope" } }));
    expect(edited.apply.preflight).toBeNull();
  });
});

describe("stale-membership protection", () => {
  it("blocks live apply when a case was added to the test set after the comparison", async () => {
    const draft = resolveNeedsReview((await comparedDraft()).id);
    const added = spira.addMember(125, { testCaseId: 9001, name: "Added by someone else" });

    const { preflight } = await runPreflight(draft.id);
    expect(preflight.ok).toBe(false);
    expect(preflight.seal).toBeNull();
    expect(preflight.sets[0].unexpected).toEqual([added.testSetTestCaseId]);
    await expect(applyBatch(draft.id, live(outOfScope(draft.id).slice(0, 1)))).rejects.toThrow(/membership check/);
    expect(spira.deletes).toEqual([]);
  });

  it("skips a case that left the test set between the check and the apply", async () => {
    const draft = await readyForLive();
    const [first] = outOfScope(draft.id);
    const set = spira.testSets.get(125)!;
    set.members = set.members.filter((m) => m.testSetTestCaseId !== first.testSetTestCaseId);
    const { results } = await applyBatch(draft.id, live([first]));
    expect(results[0]).toMatchObject({ status: "skipped", message: "No longer in this test set in Spira." });
    expect(spira.deletes).toEqual([]);
  });

  it("refuses to remove a membership that now points at a different test case", async () => {
    const draft = await readyForLive();
    const [first] = outOfScope(draft.id);
    spira.testSets.get(125)!.members.find((m) => m.testSetTestCaseId === first.testSetTestCaseId)!.testCaseId = 7777;
    const { results } = await applyBatch(draft.id, live([first]));
    expect(results[0].status).toBe("failed");
    expect(results[0].message).toMatch(/Recompare/);
    expect(spira.deletes).toEqual([]);
  });
});

describe("apply against Spira", () => {
  it("dry run never removes anything", async () => {
    const draft = await comparedDraft();
    for (const actions of chunk(outOfScope(draft.id), 25)) {
      const { results } = await applyBatch(draft.id, dry(actions));
      expect(results.every((r) => r.status === "wouldRemove")).toBe(true);
    }
    expect(spira.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(spira.members(125)).toHaveLength(60);
  });

  it("removes in batches, retries only the failed case, and verifies as applied", async () => {
    const draft = await readyForLive();
    const out = outOfScope(draft.id);
    spira.failNextDelete.add(out[4].testSetTestCaseId);

    const first = await liveApplyAll(draft.id);
    const failed = first.filter((r) => r.status === "failed");
    expect(first).toHaveLength(30);
    expect(failed.map((r) => r.testSetTestCaseId)).toEqual([out[4].testSetTestCaseId]);
    expect(failed[0].message).toMatch(/HTTP 500/);
    expect(new Set(spira.deletes)).toEqual(new Set(out.map((a) => a.testSetTestCaseId)));

    const partial = await verifyApply(draft.id);
    expect(partial.draft.status).toBe("appliedWithErrors");
    expect(partial.verification.sets[0].stillPresent).toEqual([out[4].testSetTestCaseId]);

    const deletesBefore = spira.deletes.length;
    const resent = await applyBatch(draft.id, live(failed.map(({ testCaseId, testSetTestCaseId }) => ({ testCaseId, testSetTestCaseId }))));
    expect(resent.results.map((r) => r.status)).toEqual(["removed"]);
    expect(spira.deletes.length).toBe(deletesBefore + 1);

    const done = await verifyApply(draft.id);
    expect(done.verification.ok).toBe(true);
    expect(done.draft.status).toBe("applied");
    expect(summarizeDraft(done.draft).status).toBe("applied");
    expect(spira.members(125)).toHaveLength(30);
  });

  it("never re-sends actions that already succeeded", async () => {
    const draft = await readyForLive();
    const [action] = outOfScope(draft.id);
    expect((await applyBatch(draft.id, live([action]))).results[0].status).toBe("removed");
    const again = await applyBatch(draft.id, live([action]));
    expect(again.results[0]).toMatchObject({ status: "skipped", message: "Already removed in an earlier run." });
    expect(spira.deletes).toEqual([action.testSetTestCaseId]);
  });
});

describe("removed Mock mode", () => {
  it("deletes drafts and simulated state left over from Mock mode", async () => {
    const real = await comparedDraft();
    writeItem("draft:legacy-mock-draft", { ...real, id: "legacy-mock-draft", mock: true });
    writeItem("mock-state", { removed: {}, transientFailureUsed: {} });

    expect(purgeMockData()).toBe(1);
    expect(readItem("draft:legacy-mock-draft")).toBeNull();
    expect(readItem("mock-state")).toBeNull();
    expect(listDrafts().map((d) => d.id)).toEqual([real.id]);
  });
});
