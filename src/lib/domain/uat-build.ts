import { emptyApplyState } from "@/lib/domain/draft-ops";
import type { Draft, TestSetComparison } from "@/lib/domain/types";

/** Draft ids for the UAT build workspace: `uat-{releaseId}-{moduleSlug}` (matches drafts ID pattern). */
export const UAT_DRAFT_PREFIX = "uat-";

export function moduleSlug(module: string): string {
  return module
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "module";
}

/** Stable draft id for one module on a release. Length 8–64, `[a-zA-Z0-9-]`. */
export function uatDraftId(releaseId: number, module: string): string {
  const prefix = `uat-${releaseId}-`;
  const maxSlug = Math.max(1, 64 - prefix.length);
  const id = `${prefix}${moduleSlug(module).slice(0, maxSlug)}`;
  return id.length >= 8 ? id : `${id}-board`.slice(0, 64);
}

export function isUatDraftId(id: string): boolean {
  return /^uat-\d+-[a-z0-9-]+$/i.test(id);
}

export function isUatDraftForRelease(id: string, releaseId: number): boolean {
  return id.startsWith(`uat-${releaseId}-`) && isUatDraftId(id);
}

/** Pure shape of a UAT draft from a week catalog module (no I/O). */
export function draftFromWeekModule(
  catalog: { projectId: number; releaseId: number; releaseLabel: string },
  module: { module: string; testSets: TestSetComparison[] },
  now = new Date().toISOString(),
): Draft {
  const id = uatDraftId(catalog.releaseId, module.module);
  return {
    id,
    name: `${module.module} · ${catalog.releaseLabel}`,
    module: module.module,
    projectId: catalog.projectId,
    releaseId: catalog.releaseId,
    releaseLabel: catalog.releaseLabel,
    status: "applied",
    createdAt: now,
    updatedAt: now,
    source: { fileName: "Spira UAT build", inScopeSheet: "Spira", needsConfirmationSheet: null },
    rows: [],
    testSetIds: module.testSets.map((s) => s.testSetId),
    testSetRefs: module.testSets.map((s) => ({ testSetId: s.testSetId, testSetName: s.testSetName, platform: s.platform })),
    testSets: module.testSets,
    compareErrors: {},
    decisions: {},
    history: [],
    apply: {
      ...emptyApplyState(),
      completedWithoutChanges: now,
    },
    testSetKeywords: {},
    blockedReview: {},
  };
}
