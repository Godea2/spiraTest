import { describe, expect, it } from "vitest";
import { countColumns } from "@/lib/domain/board";
import { buildFixture, mockApply, mockReconcile } from "@/lib/server/mock";

describe("mock reconciliation fixture", () => {
  it("returns exactly 211 cards for test set 125 split 142 / 64 / 5", async () => {
    const { cards, missingFromSpira, membership } = await mockReconcile(125, "Onboarding");
    expect(cards).toHaveLength(211);
    expect(countColumns(cards, {})).toEqual({ inScope: 142, outOfScope: 64, needsReview: 5, total: 211 });
    expect(missingFromSpira).toHaveLength(2);
    expect(membership).toHaveLength(211);
  });

  it("uses case IDs 3519–3729 and membership IDs starting at 12318", () => {
    const cards = buildFixture(125, "Onboarding");
    const caseIds = cards.map((c) => c.testCaseId);
    expect(Math.min(...caseIds)).toBe(3519);
    expect(Math.max(...caseIds)).toBe(3729);
    expect(new Set(caseIds).size).toBe(211);
    expect(Math.min(...cards.map((c) => c.testSetTestCaseId))).toBe(12318);
  });

  it("includes executed cases, some of which are suggested Out of Scope", () => {
    const cards = buildFixture(125, "Onboarding");
    expect(cards.some((c) => c.executed)).toBe(true);
    expect(cards.some((c) => c.executed && c.suggestion === "outOfScope")).toBe(true);
  });

  it("suggests case 3661 Out of Scope so the transient failure is reachable", () => {
    const card = buildFixture(125, "Onboarding").find((c) => c.testCaseId === 3661);
    expect(card?.suggestion).toBe("outOfScope");
  });
});

describe("mock apply", () => {
  const target = () => buildFixture(125, "Onboarding").find((c) => c.testCaseId === 3661)!;

  it("dry run does not change membership", async () => {
    const card = target();
    const results = await mockApply(125, [card], true);
    expect(results[0].status).toBe("wouldRemove");
    const { cards } = await mockReconcile(125, "Onboarding");
    expect(cards).toHaveLength(211);
  });

  it("fails case 3661 once on live apply, then succeeds on retry", async () => {
    const card = target();
    const first = await mockApply(125, [card], false);
    expect(first[0].status).toBe("failed");
    expect((await mockReconcile(125, "Onboarding")).cards).toHaveLength(211);

    const retry = await mockApply(125, [card], false);
    expect(retry[0].status).toBe("removed");
    expect((await mockReconcile(125, "Onboarding")).cards).toHaveLength(210);
  });
});
