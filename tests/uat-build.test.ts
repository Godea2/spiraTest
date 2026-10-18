import { describe, expect, it } from "vitest";
import {
  draftFromWeekModule,
  isUatDraftForRelease,
  isUatDraftId,
  moduleSlug,
  uatDraftId,
} from "@/lib/domain/uat-build";
import type { TestSetComparison } from "@/lib/domain/types";

const set = (testSetId: number, name: string): TestSetComparison => ({
  testSetId,
  testSetName: name,
  platform: "iOS",
  comparedAt: "2026-10-18T12:00:00.000Z",
  cards: [
    {
      key: `${testSetId}:1`,
      testSetId,
      testCaseId: 100 + testSetId,
      testSetTestCaseId: 1,
      name: "Sample case",
      tcId: null,
      executionStatus: "Not Run",
      executed: false,
      suggestion: "inScope",
      reason: "",
    },
  ],
  missingFromSpira: [],
  baselineMembership: [1],
  seal: "",
});

describe("uat draft ids", () => {
  it("builds stable ids that match the drafts storage pattern", () => {
    const id = uatDraftId(24, "Customer Onboarding & Home Screen");
    expect(id).toBe("uat-24-customer-onboarding-home-screen");
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(isUatDraftId(id)).toBe(true);
    expect(isUatDraftId("week:Cards")).toBe(false);
    expect(isUatDraftForRelease(id, 24)).toBe(true);
    expect(isUatDraftForRelease(id, 25)).toBe(false);
  });

  it("slugs modules safely", () => {
    expect(moduleSlug("Cards")).toBe("cards");
    expect(moduleSlug("  Profile & Notifications  ")).toBe("profile-notifications");
  });

  it("shapes a draft from a catalog module with applied status", () => {
    const draft = draftFromWeekModule(
      { projectId: 24, releaseId: 4, releaseLabel: "1.0.0.0.0004" },
      { module: "Cards", testSets: [set(10, "Cards - iOS")] },
      "2026-10-18T12:00:00.000Z",
    );
    expect(draft.id).toBe("uat-4-cards");
    expect(draft.status).toBe("applied");
    expect(draft.testSets).toHaveLength(1);
    expect(draft.testSets[0].cards).toHaveLength(1);
    expect(draft.apply.completedWithoutChanges).toBe("2026-10-18T12:00:00.000Z");
  });
});
