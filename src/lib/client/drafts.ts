import { summarizeDraft } from "@/lib/domain/board";
import { emptyApplyState } from "@/lib/domain/draft-ops";
import { executionCards, executionCounts } from "@/lib/domain/execution";
import type { Draft, DraftSummary } from "@/lib/domain/types";
import { logActivity } from "./activity";
import { keysWithPrefix, readItem, removeItem, writeItem } from "./storage";
import { storeSync } from "./store-sync";

const PREFIX = "draft:";
const ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

export class DraftNotFoundError extends Error {
  constructor() {
    super(
      storeSync.state().mode === "cloud"
        ? "Draft not found. It may have been deleted."
        : "Draft not found in this browser. Drafts are saved per browser; open it where it was created.",
    );
  }
}

export class DraftConflictError extends Error {
  constructor() {
    super("This draft was changed in another tab. Reload it to see the latest version.");
  }
}

function keyFor(id: string): string {
  if (!ID_PATTERN.test(id)) throw new DraftNotFoundError();
  return PREFIX + id;
}

export function getDraft(id: string): Draft {
  const draft = readItem<Draft>(keyFor(id));
  if (!draft) throw new DraftNotFoundError();
  return draft;
}

/** Every draft in full, most recently updated first. */
export function allDrafts(): Draft[] {
  return keysWithPrefix(PREFIX)
    .map((key) => readItem<Draft>(key))
    .filter((draft): draft is Draft => draft !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listDrafts(): DraftSummary[] {
  return allDrafts()
    .map((draft) => {
      if (!draft.execution) return summarizeDraft(draft);
      const counts = executionCounts(executionCards(draft), draft.execution);
      return { ...summarizeDraft(draft), execution: { executed: counts.total - counts.notRun, total: counts.total } };
    });
}

/**
 * Mock mode has been removed. Drafts made with simulated data, and the simulated Spira
 * state, are deleted so they can never be mistaken for real comparisons.
 */
export function purgeMockData(): number {
  removeItem("mock-state");
  let removed = 0;
  for (const key of keysWithPrefix(PREFIX)) {
    if (readItem<{ mock?: unknown }>(key)?.mock === true) {
      removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

export type NewDraft = Pick<
  Draft,
  "name" | "module" | "projectId" | "releaseId" | "releaseLabel" | "source" | "rows" | "testSetIds" | "testSetRefs"
> &
  Partial<Pick<Draft, "mirror">>;

export function createDraft(input: NewDraft): Draft {
  const now = new Date().toISOString();
  const draft: Draft = {
    ...input,
    id: crypto.randomUUID(),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    testSets: [],
    compareErrors: {},
    decisions: {},
    history: [],
    apply: emptyApplyState(),
    testSetKeywords: {},
    blockedReview: {},
  };
  writeItem(keyFor(draft.id), draft);
  logActivity({
    type: "draft.created",
    message: `Created draft "${draft.name}" with ${draft.rows.length} workbook rows.`,
    draftId: draft.id,
    module: draft.module,
    details: { testSetIds: draft.testSetIds },
  });
  return draft;
}

/**
 * Read-modify-write. When `expectedUpdatedAt` is given the write is rejected if the
 * draft was saved elsewhere (another tab) in between.
 */
export function mutateDraft(id: string, mutate: (draft: Draft) => void, expectedUpdatedAt?: string): Draft {
  const current = getDraft(id);
  if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) throw new DraftConflictError();
  const next = structuredClone(current);
  mutate(next);
  const now = new Date().toISOString();
  next.updatedAt = now > current.updatedAt ? now : new Date(Date.parse(current.updatedAt) + 1).toISOString();
  writeItem(keyFor(id), next);
  return next;
}

export function renameDraft(id: string, name: string, expectedUpdatedAt?: string): Draft {
  const from = getDraft(id).name;
  const draft = mutateDraft(id, (d) => void (d.name = name.trim()), expectedUpdatedAt);
  if (from !== draft.name) {
    logActivity({ type: "draft.renamed", message: `Renamed "${from}" to "${draft.name}".`, draftId: id, module: draft.module });
  }
  return draft;
}

export function duplicateDraft(id: string): Draft {
  const source = getDraft(id);
  const now = new Date().toISOString();
  const copy: Draft = {
    ...structuredClone(source),
    id: crypto.randomUUID(),
    name: `${source.name} (copy)`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    apply: emptyApplyState(),
    execution: undefined,
  };
  writeItem(keyFor(copy.id), copy);
  logActivity({ type: "draft.duplicated", message: `Duplicated "${source.name}".`, draftId: copy.id, module: copy.module });
  return copy;
}

export function deleteDraft(id: string): void {
  const draft = getDraft(id);
  removeItem(keyFor(id));
  logActivity({ type: "draft.deleted", message: `Deleted draft "${draft.name}".`, draftId: id, module: draft.module });
}
