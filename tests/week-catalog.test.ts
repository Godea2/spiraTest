import { describe, expect, it } from "vitest";
import {
  dedupeAcrossModulesSamePlatform,
  dedupeCardsByTestCaseId,
  normalizeModuleStem,
  preferCatalogSet,
  prettyModuleLabel,
  stemsMatch,
} from "@/lib/domain/week-catalog";
import type { Card, TestSetComparison } from "@/lib/domain/types";

const card = (overrides: Partial<Card> & Pick<Card, "testCaseId" | "testSetTestCaseId">): Card => ({
  key: `${overrides.testSetId ?? 1}:${overrides.testSetTestCaseId}`,
  testSetId: overrides.testSetId ?? 1,
  testCaseId: overrides.testCaseId,
  testSetTestCaseId: overrides.testSetTestCaseId,
  name: overrides.name ?? `TC${overrides.testCaseId}`,
  tcId: null,
  executionStatus: overrides.executionStatus ?? "Not Run",
  executed: overrides.executed ?? false,
  suggestion: "inScope",
  reason: "",
});

const set = (platform: "Android" | "iOS", testSetId: number, cards: Card[]): TestSetComparison => ({
  testSetId,
  testSetName: `Set ${platform}`,
  platform,
  comparedAt: "2026-11-13T00:00:00.000Z",
  cards,
  missingFromSpira: [],
  baselineMembership: cards.map((c) => c.testSetTestCaseId).sort((a, b) => a - b),
  seal: "test",
});

describe("normalizeModuleStem / stemsMatch / prettyModuleLabel", () => {
  it("collapses and/& so Accounts variants share a stem", () => {
    expect(normalizeModuleStem("Accounts and Transactions")).toBe("accounts & transactions");
    expect(stemsMatch("Accounts and Transactions", "Accounts & Transactions")).toBe(true);
    expect(prettyModuleLabel("Accounts and Transactions")).toBe("Accounts & Transactions");
  });

  it("matches Transfer ↔ Transfers", () => {
    expect(stemsMatch("transfer", "transfers")).toBe(true);
    expect(prettyModuleLabel("Transfer")).toBe("Transfers");
  });
});

describe("dedupeCardsByTestCaseId", () => {
  it("keeps one membership when the same testCaseId appears twice in a set", () => {
    const cards = [
      card({ testCaseId: 10, testSetTestCaseId: 200, executionStatus: "Not Run", executed: false }),
      card({ testCaseId: 10, testSetTestCaseId: 100, executionStatus: "Not Run", executed: false }),
      card({ testCaseId: 11, testSetTestCaseId: 101 }),
    ];
    const out = dedupeCardsByTestCaseId(cards);
    expect(out.map((c) => c.testCaseId).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(out.find((c) => c.testCaseId === 10)?.testSetTestCaseId).toBe(100);
  });

  it("prefers an executed membership over Not Run for the same testCaseId", () => {
    const out = dedupeCardsByTestCaseId([
      card({ testCaseId: 10, testSetTestCaseId: 50, executionStatus: "Not Run", executed: false }),
      card({ testCaseId: 10, testSetTestCaseId: 90, executionStatus: "Passed", executed: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].testSetTestCaseId).toBe(90);
    expect(out[0].executed).toBe(true);
  });
});

describe("preferCatalogSet", () => {
  it("prefers the working-release set over a richer off-release set", () => {
    const off = {
      onRelease: false,
      comparison: set("Android", 1, [card({ testCaseId: 1, testSetTestCaseId: 1 }), card({ testCaseId: 2, testSetTestCaseId: 2 })]),
    };
    const on = {
      onRelease: true,
      comparison: set("Android", 2, [card({ testCaseId: 1, testSetTestCaseId: 3 })]),
    };
    expect(preferCatalogSet(off, on)).toBe(true);
    expect(preferCatalogSet(on, off)).toBe(false);
  });

  it("when both are on-release, prefers the richer set", () => {
    const small = {
      onRelease: true,
      comparison: set("Android", 1, [card({ testCaseId: 1, testSetTestCaseId: 1 })]),
    };
    const big = {
      onRelease: true,
      comparison: set("Android", 2, [card({ testCaseId: 1, testSetTestCaseId: 1 }), card({ testCaseId: 2, testSetTestCaseId: 2 })]),
    };
    expect(preferCatalogSet(small, big)).toBe(true);
  });
});

describe("dedupeAcrossModulesSamePlatform", () => {
  it("drops the same TC on Android from a second module, keeps iOS twin", () => {
    const modules = dedupeAcrossModulesSamePlatform([
      {
        module: "Payments",
        onRelease: true,
        testSets: [set("Android", 10, [card({ testSetId: 10, testCaseId: 99, testSetTestCaseId: 1, name: "Pay" })])],
      },
      {
        module: "Transfers",
        onRelease: true,
        testSets: [
          set("Android", 20, [card({ testSetId: 20, testCaseId: 99, testSetTestCaseId: 2, name: "Pay" })]),
          set("iOS", 21, [card({ testSetId: 21, testCaseId: 99, testSetTestCaseId: 3, name: "Pay" })]),
        ],
      },
    ]);

    const transfers = modules.find((m) => m.module === "Transfers")!;
    // Payments is not an expected Prod stem; Transfers is — Android 99 stays on Transfers only,
    // and the emptied Payments module is dropped.
    expect(modules.map((m) => m.module)).toEqual(["Transfers"]);
    expect(transfers.testSets.find((s) => s.platform === "Android")?.cards.map((c) => c.testCaseId)).toEqual([99]);
    expect(transfers.testSets.find((s) => s.platform === "iOS")?.cards.map((c) => c.testCaseId)).toEqual([99]);
  });

  it("keeps Android + iOS twins of the same testCaseId in one module", () => {
    const modules = dedupeAcrossModulesSamePlatform([
      {
        module: "Transfers",
        onRelease: true,
        testSets: [
          set("Android", 1, [card({ testSetId: 1, testCaseId: 5, testSetTestCaseId: 10 })]),
          set("iOS", 2, [card({ testSetId: 2, testCaseId: 5, testSetTestCaseId: 11 })]),
        ],
      },
    ]);
    expect(modules).toHaveLength(1);
    expect(modules[0].testSets.flatMap((s) => s.cards).map((c) => `${c.testSetId}:${c.testCaseId}`).sort()).toEqual([
      "1:5",
      "2:5",
    ]);
  });
});
