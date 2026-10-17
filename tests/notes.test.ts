import { describe, expect, it } from "vitest";
import { defaultNotesSelection, shapeNotesParse } from "@/lib/domain/notes";
import { picksFromNotes } from "@/lib/client/notes";
import type { ProgressTarget } from "@/lib/domain/progress";
import type { MappedNotesItem } from "@/lib/client/notes";

describe("shapeNotesParse", () => {
  it("splits done / left, drops empties, assigns ids", () => {
    const out = shapeNotesParse("Cards update", [
      { text: "  User can create virtual cards  ", bucket: "done", moduleHint: "Cards", platform: "both" },
      { text: "", bucket: "done", moduleHint: "", platform: "unknown" },
      { text: "Freeze and unfreeze", bucket: "left", moduleHint: "Cards", platform: "unknown" },
      { text: "User can create virtual cards", bucket: "done", moduleHint: "Cards", platform: "both" },
      { text: "See tier upgrade CTA", bucket: "done", moduleHint: "Accounts & Transactions", platform: "iOS" },
    ]);
    expect(out.title).toBe("Cards update");
    expect(out.items).toHaveLength(3);
    expect(out.items[0]).toMatchObject({ id: "n1", bucket: "done", platform: "both", moduleHint: "Cards" });
    expect(out.items[1]).toMatchObject({ id: "n2", bucket: "left", platform: null });
    expect(out.items[2].platform).toBe("iOS");
  });
});

describe("defaultNotesSelection", () => {
  const matches = [
    { key: "a|1", name: "Request virtual card", relevance: "high" as const },
    { key: "a|2", name: "Block card", relevance: "medium" as const },
    { key: "a|3", name: "Unrelated photo", relevance: "low" as const },
  ];

  it("ticks at most one case for done notes", () => {
    const selected = defaultNotesSelection(
      { id: "n1", text: "User is able to successfully create virtual cards", bucket: "done", moduleHint: "Cards", platform: "both" },
      matches,
    );
    expect([...selected]).toEqual(["a|1"]);
  });

  it("never auto-selects for left notes", () => {
    const selected = defaultNotesSelection(
      { id: "n2", text: "Freeze and unfreeze", bucket: "left", moduleHint: "Cards", platform: null },
      matches,
    );
    expect([...selected]).toEqual([]);
  });
});

describe("picksFromNotes", () => {
  it("only builds Passed picks from done selected cases", () => {
    const target = (key: string, id: number): ProgressTarget => ({
      draftId: "d1",
      draftName: "Cards",
      module: "Cards",
      completed: true,
      testSetName: "Cards - iOS",
      column: "inScope",
      card: {
        key,
        testSetId: 1,
        testCaseId: id,
        testSetTestCaseId: id,
        name: `Case ${id}`,
        tcId: null,
        executionStatus: "Not Run",
        executed: false,
        suggestion: "inScope",
        reason: "",
      },
    });
    const mapped: MappedNotesItem[] = [
      {
        item: { id: "n1", text: "Create virtual cards", bucket: "done", moduleHint: "Cards", platform: "both" },
        matches: [
          { target: target("1:1", 1), candidate: { key: "1:1", relevance: "high" } },
          { target: target("1:2", 2), candidate: { key: "1:2", relevance: "medium" } },
        ],
        selected: new Set(["d1|1:1"]),
        error: null,
      },
      {
        item: { id: "n2", text: "Block cards", bucket: "left", moduleHint: "Cards", platform: null },
        matches: [{ target: target("1:3", 3), candidate: { key: "1:3", relevance: "high" } }],
        selected: new Set(["d1|1:3"]),
        error: null,
      },
    ];
    const picks = picksFromNotes(mapped);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ status: "passed", comment: expect.stringContaining("Create virtual cards") });
    expect(picks[0].target.card.testCaseId).toBe(1);
  });
});
