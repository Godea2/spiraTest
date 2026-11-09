import { beforeEach, describe, expect, it } from "vitest";
import { createDraft, deleteDraft, putDraft } from "@/lib/client/drafts";
import { deleteCompletedDrafts, formatBytes, measureAppStorage } from "@/lib/client/storage-cleanup";
import { emptyApplyState } from "@/lib/domain/draft-ops";
import type { Draft } from "@/lib/domain/types";

beforeEach(() => {
  globalThis.localStorage?.clear();
});

describe("storage cleanup", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("deletes Completed Compare drafts but keeps UAT modules and open drafts", () => {
    const open = createDraft({
      name: "Open compare",
      module: "Cards",
      projectId: 24,
      releaseId: 160,
      releaseLabel: "UAT",
      source: { fileName: "x.xlsx", inScopeSheet: "In Scope", needsConfirmationSheet: null },
      rows: [],
      testSetIds: [1],
      testSetRefs: [],
    });

    const completed: Draft = {
      ...open,
      id: crypto.randomUUID(),
      name: "Completed Cards",
      status: "applied",
      apply: { ...emptyApplyState(), lastLiveRunAt: new Date().toISOString() },
    };
    putDraft(completed);

    const uat: Draft = {
      ...open,
      id: "uat-160-cards",
      name: "UAT · Cards",
      status: "applied",
      apply: { ...emptyApplyState(), lastLiveRunAt: new Date().toISOString() },
    };
    putDraft(uat);

    const usage = measureAppStorage();
    expect(usage.completedDrafts).toBe(1);
    expect(usage.uatDrafts).toBe(1);

    const result = deleteCompletedDrafts();
    expect(result.deleted).toBe(1);
    expect(measureAppStorage().completedDrafts).toBe(0);
    expect(measureAppStorage().uatDrafts).toBe(1);
    expect(measureAppStorage().drafts).toBe(2); // open + uat

    deleteDraft(open.id);
    deleteDraft(uat.id);
  });
});
