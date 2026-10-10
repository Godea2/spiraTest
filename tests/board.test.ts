import { describe, expect, it } from "vitest";
import {
  applyChanges,
  chunk,
  countColumns,
  diffMembership,
  executedMovingOut,
  intendedMembership,
  moveCards,
  preserveDecisions,
  removalActions,
} from "@/lib/domain/board";
import type { Card, TestSetComparison } from "@/lib/domain/types";

function card(id: number, suggestion: Card["suggestion"], executed = false): Card {
  return {
    key: `1:${id}`,
    testSetId: 1,
    testCaseId: id + 1000,
    testSetTestCaseId: id,
    name: `Case ${id}`,
    tcId: `TC-${id}`,
    executionStatus: executed ? "Passed" : "Not Run",
    executed,
    suggestion,
    reason: "",
  };
}

const cards = [card(1, "inScope"), card(2, "outOfScope", true), card(3, "needsReview"), card(4, "inScope", true)];
const set: TestSetComparison = {
  testSetId: 1,
  testSetName: "Set",
  platform: "iOS",
  comparedAt: "",
  cards,
  missingFromSpira: [],
  baselineMembership: [1, 2, 3, 4],
};

describe("board moves", () => {
  it("records only real changes and stores only overrides", () => {
    const { decisions, changes } = moveCards(cards, {}, ["1:1", "1:2"], "outOfScope");
    expect(changes).toEqual([{ key: "1:1", from: "inScope", to: "outOfScope" }]);
    expect(decisions).toEqual({ "1:1": "outOfScope" });
  });

  it("drops the override when a card is moved back to its suggestion", () => {
    const moved = moveCards(cards, {}, ["1:1"], "outOfScope").decisions;
    expect(moveCards(cards, moved, ["1:1"], "inScope").decisions).toEqual({});
  });

  it("undo and redo are symmetrical", () => {
    const { decisions, changes } = moveCards(cards, {}, ["1:1", "1:3"], "outOfScope");
    const undone = applyChanges(cards, decisions, changes, "undo");
    expect(undone).toEqual({});
    expect(applyChanges(cards, undone, changes, "redo")).toEqual(decisions);
  });

  it("flags executed cases moving to Out of Scope", () => {
    expect(executedMovingOut(cards, {}, ["1:4", "1:1"], "outOfScope").map((c) => c.key)).toEqual(["1:4"]);
    expect(executedMovingOut(cards, {}, ["1:2"], "outOfScope")).toEqual([]);
    expect(executedMovingOut(cards, {}, ["1:4"], "needsReview")).toEqual([]);
  });

  it("recompare keeps decisions only for cards that still exist", () => {
    const decisions = { "1:1": "outOfScope" as const, "1:99": "inScope" as const };
    expect(preserveDecisions(decisions, cards)).toEqual({ "1:1": "outOfScope" });
  });
});

describe("apply planning", () => {
  it("removal actions include suggested Out of Scope cards the user never touched", () => {
    expect(removalActions(set, {})).toEqual([{ testCaseId: 1002, testSetTestCaseId: 2 }]);
  });

  it("intended membership is the baseline minus Out of Scope cards", () => {
    expect(intendedMembership(set, { "1:4": "outOfScope" })).toEqual([1, 3]);
  });

  it("counts follow decisions", () => {
    expect(countColumns(cards, { "1:3": "inScope" })).toEqual({ inScope: 3, outOfScope: 1, needsReview: 0, total: 4 });
  });

  it("batches at most 25", () => {
    const batches = chunk(Array.from({ length: 64 }, (_, i) => i), 25);
    expect(batches.map((b) => b.length)).toEqual([25, 25, 14]);
  });

  it("diffs membership both ways", () => {
    expect(diffMembership([1, 2, 3], [2, 3, 4])).toEqual({ unexpected: [4], missing: [1] });
  });
});
