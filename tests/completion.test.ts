import { describe, expect, it } from "vitest";
import { completionBlocker, needsReopening, pendingRemovals, summarizeDraft } from "@/lib/domain/board";
import { emptyApplyState, recordBoardEdits, recordCleanCompletion, recordComparison, recordVerification } from "@/lib/domain/draft-ops";
import type { Card, Draft, TestSetComparison, VerificationResult } from "@/lib/domain/types";

function card(id: number, suggestion: Card["suggestion"]): Card {
  return {
    key: `1:${id}`,
    testSetId: 1,
    testCaseId: id + 1000,
    testSetTestCaseId: id,
    name: `Case ${id}`,
    tcId: `TC-${id}`,
    executionStatus: "Not Run",
    executed: false,
    suggestion,
    reason: "",
  };
}

const comparison = (cards: Card[]): TestSetComparison => ({
  testSetId: 1,
  testSetName: "Payments iOS",
  platform: "iOS",
  comparedAt: "2026-10-11T09:00:00.000Z",
  cards,
  missingFromSpira: [],
  baselineMembership: cards.map((c) => c.testSetTestCaseId),
  seal: "",
});

const draftWith = (cards: Card[], status: Draft["status"] = "draft"): Draft =>
  ({
    id: "d1",
    name: "Payments",
    module: "Payments",
    projectId: 24,
    status,
    createdAt: "",
    updatedAt: "u",
    testSetIds: [1],
    testSets: [comparison(cards)],
    compareErrors: {},
    decisions: {},
    history: [],
    apply: emptyApplyState(),
  }) as unknown as Draft;

const matches: VerificationResult = { at: "2026-10-11T10:00:00.000Z", ok: true, sets: [{ testSetId: 1, ok: true, stillPresent: [], unexpectedlyRemoved: [] }] };
const differs: VerificationResult = { at: "2026-10-11T10:00:00.000Z", ok: false, sets: [{ testSetId: 1, ok: false, stillPresent: [9], unexpectedlyRemoved: [] }] };

describe("completing a draft with nothing to change", () => {
  it("is ready when every case is kept and nothing needs review", () => {
    const draft = draftWith([card(1, "inScope"), card(2, "defects"), card(3, "blocked")]);
    expect(pendingRemovals(draft)).toBe(0);
    expect(completionBlocker(draft)).toBeNull();
    expect(summarizeDraft(draft).readyToComplete).toBe(true);
  });

  it("is not ready while cases wait to be removed or reviewed, or a test set is not compared", () => {
    expect(completionBlocker(draftWith([card(1, "inScope"), card(2, "outOfScope")]))).toBe("1 Out of Scope case to remove with a live apply.");
    expect(completionBlocker(draftWith([card(1, "needsReview"), card(2, "needsReview")]))).toBe("2 cards are in Needs Review.");
    expect(completionBlocker({ ...draftWith([card(1, "inScope")]), testSetIds: [1, 2] })).toBe("Every test set must be compared first.");
    expect(completionBlocker(draftWith([card(1, "inScope")], "applied"))).toBe("Already completed.");
  });

  it("is ready once every Out of Scope case is gone from Spira, however it was removed", () => {
    const draft = draftWith([card(1, "inScope"), card(2, "outOfScope")]);
    draft.apply.removed = { "1": [2] };
    expect(pendingRemovals(draft)).toBe(0);
    expect(completionBlocker(draft)).toBeNull();
  });

  it("completes only when Spira matches the board", () => {
    const draft = draftWith([card(1, "inScope")]);
    expect(recordCleanCompletion(draft, differs)).toBe(false);
    expect(draft.status).toBe("draft");

    expect(recordCleanCompletion(draft, matches)).toBe(true);
    expect(draft.status).toBe("applied");
    expect(draft.apply.completedWithoutChanges).toBe(matches.at);
    const summary = summarizeDraft(draft);
    expect(summary.completedAt).toBe(matches.at);
    expect(summary.completedWithoutChanges).toBe(true);
    expect(summary.readyToComplete).toBe(false);
  });

  it("a later verified live apply is no longer shown as completed without changes", () => {
    const draft = draftWith([card(1, "inScope")]);
    recordCleanCompletion(draft, matches);
    draft.apply.lastLiveRunAt = "2026-10-12T10:00:00.000Z";
    recordVerification(draft, matches);
    expect(draft.apply.completedWithoutChanges).toBeNull();
    expect(summarizeDraft(draft).completedWithoutChanges).toBe(false);
  });
});

describe("reopening a completed draft", () => {
  it("goes back to Drafts when a card moves to Out of Scope or Needs Review", () => {
    const draft = draftWith([card(1, "inScope"), card(2, "inScope")]);
    recordCleanCompletion(draft, matches);

    recordBoardEdits(draft, { decisions: { "1:2": "blocked" } });
    expect(draft.status).toBe("applied");
    expect(needsReopening(draft)).toBe(false);

    recordBoardEdits(draft, { decisions: { "1:2": "outOfScope" } });
    expect(draft.status).toBe("draft");
    expect(completionBlocker(draft)).toBe("1 Out of Scope case to remove with a live apply.");
  });

  it("stays completed for Out of Scope cases already removed", () => {
    const draft = draftWith([card(1, "inScope"), card(2, "outOfScope")]);
    draft.apply.removed = { "1": [2] };
    recordCleanCompletion(draft, matches);
    recordBoardEdits(draft, { decisions: { "1:1": "defects" } });
    expect(draft.status).toBe("applied");
  });

  it("goes back to Drafts when a recompare finds cases to review", () => {
    const draft = draftWith([card(1, "inScope")]);
    recordCleanCompletion(draft, matches);
    recordComparison(draft, comparison([card(1, "inScope")]));
    expect(draft.status).toBe("applied");

    recordComparison(draft, comparison([card(1, "inScope"), card(5, "needsReview")]));
    expect(draft.status).toBe("draft");
  });
});
