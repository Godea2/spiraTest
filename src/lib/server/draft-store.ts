import "server-only";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { summarizeDraft } from "@/lib/domain/board";
import type { Draft, DraftApplyState, DraftSummary } from "@/lib/domain/types";
import { dataPath, readJson, withFileLock, writeJson } from "./json-store";

const ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

export class DraftNotFoundError extends Error {
  constructor() {
    super("Draft not found.");
  }
}

export class DraftConflictError extends Error {
  constructor() {
    super("This draft was changed elsewhere. Reload it to see the latest version.");
  }
}

const draftsDir = () => dataPath("drafts");

function draftFile(id: string): string {
  if (!ID_PATTERN.test(id)) throw new DraftNotFoundError();
  return dataPath("drafts", `${id}.json`);
}

export function emptyApplyState(): DraftApplyState {
  return {
    preflight: null,
    removed: {},
    failed: {},
    verification: null,
    lastLiveRunAt: null,
    lastDryRunAt: null,
  };
}

export async function getDraft(id: string): Promise<Draft> {
  const draft = await readJson<Draft>(draftFile(id));
  if (!draft) throw new DraftNotFoundError();
  return draft;
}

export async function listDrafts(): Promise<DraftSummary[]> {
  let files: string[];
  try {
    files = await fs.readdir(draftsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const summaries: DraftSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const draft = await readJson<Draft>(dataPath("drafts", file));
    if (draft) summaries.push(summarizeDraft(draft));
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createDraft(
  input: Omit<Draft, "id" | "createdAt" | "updatedAt" | "status" | "apply" | "history" | "decisions" | "testSets" | "compareErrors"> &
    Partial<Pick<Draft, "decisions" | "history" | "testSets">>,
): Promise<Draft> {
  const now = new Date().toISOString();
  const draft: Draft = {
    ...input,
    id: randomUUID(),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    testSets: input.testSets ?? [],
    compareErrors: {},
    decisions: input.decisions ?? {},
    history: input.history ?? [],
    apply: emptyApplyState(),
  };
  await writeJson(draftFile(draft.id), draft);
  return draft;
}

/**
 * Read-modify-write under a per-draft lock. When `expectedUpdatedAt` is given the
 * write is rejected if someone else saved in between.
 */
export async function mutateDraft(
  id: string,
  mutate: (draft: Draft) => Draft | void | Promise<Draft | void>,
  expectedUpdatedAt?: string,
): Promise<Draft> {
  const file = draftFile(id);
  return withFileLock(file, async () => {
    const current = await readJson<Draft>(file);
    if (!current) throw new DraftNotFoundError();
    if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) throw new DraftConflictError();
    const copy = structuredClone(current);
    const next = (await mutate(copy)) ?? copy;
    const now = new Date().toISOString();
    next.updatedAt = now > current.updatedAt ? now : new Date(Date.parse(current.updatedAt) + 1).toISOString();
    await writeJson(file, next);
    return next;
  });
}

export async function duplicateDraft(id: string, name?: string): Promise<Draft> {
  const source = await getDraft(id);
  const now = new Date().toISOString();
  const copy: Draft = {
    ...structuredClone(source),
    id: randomUUID(),
    name: name?.trim() || `${source.name} (copy)`,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    apply: emptyApplyState(),
  };
  await writeJson(draftFile(copy.id), copy);
  return copy;
}

export async function deleteDraft(id: string): Promise<void> {
  const file = draftFile(id);
  await withFileLock(file, async () => {
    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DraftNotFoundError();
      throw error;
    }
  });
}
