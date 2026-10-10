import { describe, expect, it } from "vitest";
import { suggestTestSets } from "@/lib/domain/test-set-suggest";
import type { SpiraTestSetSummary } from "@/lib/domain/types";

const set = (testSetId: number, name: string, releaseId: number | null = null): SpiraTestSetSummary => ({
  testSetId,
  name,
  releaseId,
  releaseVersion: releaseId ? `v${releaseId}` : null,
});

// Same shape as a project that keeps one set per sprint under the same names.
const project = [
  set(36, "Onboarding"),
  set(14, "Onboarding-Android", 100),
  set(15, "Onboarding-IOS", 100),
  set(124, "Onboarding-Android", 157),
  set(125, "Onboarding-IOS", 157),
  set(118, "Cards - Android", 157),
];

const ticked = (s: ReturnType<typeof suggestTestSets>) => [...s.ticked].sort((a, b) => a - b);

describe("suggesting a module's test sets", () => {
  it("lists every set named after the module but ticks one per name, the newest", () => {
    const s = suggestTestSets(project, "Onboarding", null, null);
    expect(s.candidates.map((t) => t.testSetId).sort((a, b) => a - b)).toEqual([14, 15, 36, 124, 125]);
    expect(ticked(s)).toEqual([124, 125]);
  });

  it("ticks the sets planned for the chosen release", () => {
    expect(ticked(suggestTestSets(project, "Onboarding", null, 100))).toEqual([14, 15]);
    expect(ticked(suggestTestSets(project, "Onboarding", null, 157))).toEqual([124, 125]);
  });

  it("falls back to the newest when nothing is planned for the release", () => {
    expect(ticked(suggestTestSets(project, "Onboarding", null, 999))).toEqual([124, 125]);
  });

  it("explains each candidate's release and name clashes", () => {
    const s = suggestTestSets(project, "Onboarding", null, null);
    expect(s.notes.get(124)).toBe("Release v157 · same name as TX14");
    expect(s.notes.get(36)).toBe("No release");
  });

  it("ticks a set without a platform suffix when it is the only one", () => {
    expect(ticked(suggestTestSets([set(36, "Onboarding"), set(40, "Cards-iOS")], "Onboarding", null, null))).toEqual([36]);
  });

  it("matches the Excel alias and ignores spacing and case", () => {
    expect(ticked(suggestTestSets(project, "cards", null, null))).toEqual([118]);
    expect(ticked(suggestTestSets(project, "Debit cards", "Cards", null))).toEqual([118]);
  });
});
