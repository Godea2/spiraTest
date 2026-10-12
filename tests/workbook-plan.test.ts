import { describe, expect, it } from "vitest";
import type { Draft, SpiraTestSetSummary } from "@/lib/domain/types";
import { planWorkbook } from "@/lib/domain/workbook-plan";

const set = (testSetId: number, name: string, releaseId: number | null = 2): SpiraTestSetSummary => ({ testSetId, name, releaseId, releaseVersion: releaseId ? `1.0.0.000${releaseId}` : null });

const testSets = [
  set(1, "Onboarding-iOS"),
  set(2, "Onboarding-Android"),
  set(3, "Cards-iOS"),
  set(4, "Cards-Android"),
  set(5, "Cards-iOS", 1),
  set(6, "Profile-iOS"),
  set(7, "Profile-Android"),
  set(8, "Self Service-iOS"),
  set(9, "Self Service-Android"),
  set(10, "Accounts-iOS"),
];

function draft(id: string, module: string, testSetIds: number[], status: Draft["status"], kept = 0, out = 0): Draft {
  return {
    id,
    name: `${module} ${id}`,
    module,
    projectId: 24,
    status,
    updatedAt: "2026-10-12T10:00:00Z",
    testSetIds,
    decisions: {},
    testSets: testSetIds.map((testSetId) => ({
      testSetId,
      cards: [
        ...Array.from({ length: kept }, (_, i) => ({ key: `${testSetId}:k${i}`, suggestion: "inScope" })),
        ...Array.from({ length: out }, (_, i) => ({ key: `${testSetId}:o${i}`, suggestion: "outOfScope" })),
      ],
    })),
  } as unknown as Draft;
}

const plan = (drafts: Draft[], modules = ["Onboarding", "Cards", "Profile", "Self Service", "Selfservice App"]) =>
  planWorkbook({
    modules: modules.map((name) => ({ name, rows: 10 })),
    testSets,
    drafts,
    projectId: 24,
    releaseId: 2,
    mappings: [],
    aliases: { "Self Service": "Selfservice App" },
  });

describe("whole workbook plan", () => {
  it("skips test sets on completed drafts and compares the rest of each module", () => {
    const { modules, outside } = plan(
      [
        draft("a", "Onboarding", [1], "applied", 143, 68),
        draft("b", "Onboarding", [2], "applied", 143, 68),
        draft("c", "Profile", [6], "applied", 90),
        draft("d", "Self Service", [8, 9], "draft"),
        draft("e", "Cards", [3], "applied", 5),
        draft("f", "Cards", [3], "draft"),
        { ...draft("g", "Cards", [4], "applied"), projectId: 99 },
      ],
      ["Onboarding", "Cards", "Profile", "Selfservice App"],
    );
    const byName = Object.fromEntries(modules.map((m) => [m.module, m]));
    expect(byName.Onboarding.state).toBe("done");
    expect(byName.Onboarding.sets.map((s) => s.state)).toEqual([
      { kind: "completed", draftId: "b", draftName: "Onboarding b", kept: 143 },
      { kind: "completed", draftId: "a", draftName: "Onboarding a", kept: 143 },
    ]);
    expect(byName.Onboarding.toCompare).toEqual([]);

    expect(byName.Cards.state).toBe("partly");
    expect(byName.Cards.sets.map((s) => [s.ref.testSetId, s.state.kind])).toEqual([
      [4, "new"],
      [3, "completed"],
    ]);
    expect(byName.Cards.toCompare.map((r) => r.testSetId)).toEqual([4]);

    expect(byName.Profile.state).toBe("partly");
    expect(byName["Self Service"].state).toBe("inProgress");
    expect(outside.map((t) => t.name)).toEqual(["Accounts-iOS"]);
  });

  it("compares every release test set of a module no draft covers", () => {
    const { modules } = plan([], ["Cards"]);
    expect(modules[0]).toMatchObject({ module: "Cards", state: "new" });
    expect(modules[0].toCompare.map((r) => [r.testSetId, r.platform])).toEqual([
      [4, "Android"],
      [3, "iOS"],
    ]);
  });

  it("flags a module with no test set", () => {
    expect(plan([], ["Wallet"]).modules[0].state).toBe("noTestSets");
  });
});
