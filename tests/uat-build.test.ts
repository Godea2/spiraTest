import { beforeEach, describe, expect, it } from "vitest";
import { deleteDraft, putDraft } from "@/lib/client/drafts";
import { listUatDrafts, resetUatProgress } from "@/lib/client/uat-build";
import { emptyExecution } from "@/lib/domain/execution";
import { draftFromWeekModule, uatDraftId } from "@/lib/domain/uat-build";
import type { TestSetComparison } from "@/lib/domain/types";

describe("resetUatProgress", () => {
  const releaseId = 99;
  const catalog = { projectId: 24, releaseId, releaseLabel: "UAT 1.0" };
  const testSet: TestSetComparison = {
    testSetId: 1,
    testSetName: "Payments - iOS",
    platform: "iOS",
    comparedAt: "2026-10-20T10:00:00.000Z",
    cards: [],
    missingFromSpira: [],
    baselineMembership: [],
    seal: "test",
  };
  const module = { module: "Payments", testSets: [testSet] };

  beforeEach(() => {
    for (const d of listUatDrafts(releaseId)) {
      try {
        deleteDraft(d.id);
      } catch {
        // gone
      }
    }
  });

  it("clears local execution marks on UAT drafts for the release", () => {
    const shaped = draftFromWeekModule(catalog, module);
    putDraft({
      ...shaped,
      execution: {
        ...emptyExecution(),
        runs: [
          {
            testSetId: 1,
            testCaseId: 10,
            testSetTestCaseId: 100,
            testRunId: 5,
            status: "passed",
            comment: "",
            at: "2026-10-20T10:00:00.000Z",
            tester: "QA",
          },
        ],
        progress: { "1:100": { steps: {}, status: "passed", comment: "" } },
      },
    });

    expect(resetUatProgress(releaseId).cleared).toBe(1);
    const again = listUatDrafts(releaseId);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(uatDraftId(releaseId, "Payments"));
    expect(again[0].execution).toEqual(emptyExecution());
    expect(resetUatProgress(releaseId).cleared).toBe(0);
  });
});
