import { effectiveColumn, isCompleted } from "./board";
import { guessMapping } from "./settings";
import { moduleKey, suggestTestSets } from "./test-set-suggest";
import type { Draft, SpiraTestSetSummary, TestSetMapping, TestSetRef } from "./types";

export type SetState = { kind: "completed"; draftId: string; draftName: string; kept: number } | { kind: "inDraft"; draftId: string; draftName: string } | { kind: "new" };

export interface PlannedSet {
  ref: TestSetRef;
  releaseVersion: string | null;
  state: SetState;
}

/**
 * done: every test set is on a completed draft. inProgress: the rest are on drafts still in review.
 * partly: some test sets are covered and others are not. new: none is covered.
 */
export type ModuleState = "done" | "inProgress" | "partly" | "new" | "noTestSets";

export interface ModulePlan {
  module: string;
  rows: number;
  sets: PlannedSet[];
  /** Test sets on no draft yet: the ones a bulk comparison covers. */
  toCompare: TestSetRef[];
  state: ModuleState;
}

export interface WorkbookPlan {
  modules: ModulePlan[];
  /** iOS and Android test sets planned for the release whose module is not in the workbook. */
  outside: SpiraTestSetSummary[];
}

/** The drafts covering each test set: a completed draft wins over one still in review, then the latest. */
function coverage(drafts: Draft[], projectId: number): Map<number, SetState> {
  const out = new Map<number, { state: SetState; rank: number; at: string }>();
  for (const draft of drafts) {
    if (draft.projectId !== projectId) continue;
    const done = isCompleted(draft.status);
    for (const testSetId of draft.testSetIds) {
      const set = draft.testSets.find((s) => s.testSetId === testSetId);
      const kept = set ? set.cards.filter((c) => effectiveColumn(c, draft.decisions) !== "outOfScope" && effectiveColumn(c, draft.decisions) !== "needsReview").length : 0;
      const state: SetState = done ? { kind: "completed", draftId: draft.id, draftName: draft.name, kept } : { kind: "inDraft", draftId: draft.id, draftName: draft.name };
      const rank = done ? 2 : 1;
      const current = out.get(testSetId);
      if (!current || rank > current.rank || (rank === current.rank && draft.updatedAt > current.at)) out.set(testSetId, { state, rank, at: draft.updatedAt });
    }
  }
  return new Map([...out].map(([id, v]) => [id, v.state]));
}

const isMobile = (name: string) => {
  const { platform } = guessMapping(name);
  return platform === "iOS" || platform === "Android";
};

/**
 * What a whole workbook would do: for each of its modules, the test sets it is compared with (those
 * mapped in Settings, else the ones Compare would tick for the release) and which are already on a draft.
 */
export function planWorkbook(input: {
  modules: Array<{ name: string; rows: number }>;
  testSets: SpiraTestSetSummary[];
  drafts: Draft[];
  projectId: number;
  releaseId: number | null;
  mappings: TestSetMapping[];
  aliases: Record<string, string>;
}): WorkbookPlan {
  const covered = coverage(input.drafts, input.projectId);
  const byId = new Map(input.testSets.map((t) => [t.testSetId, t]));
  const planned = new Set<number>();
  const modules = input.modules.map(({ name: inWorkbook, rows }): ModulePlan => {
    // A workbook name set as a module's Excel alias in Settings stands for that module.
    const name = Object.entries(input.aliases).find(([, alias]) => alias.trim() && moduleKey(alias) === moduleKey(inWorkbook))?.[0] ?? inWorkbook;
    const mapped = input.mappings.filter((m) => moduleKey(m.module) === moduleKey(name));
    const suggestion = mapped.length ? null : suggestTestSets(input.testSets, name, input.aliases[name] || null, input.releaseId);
    const refs: TestSetRef[] = suggestion
      ? suggestion.candidates
          .filter((t) => suggestion.ticked.has(t.testSetId))
          .map((t) => ({ testSetId: t.testSetId, testSetName: t.name, platform: guessMapping(t.name).platform }))
      : mapped.map(({ testSetId, testSetName, platform }) => ({ testSetId, testSetName, platform }));
    const sets = refs
      .map((ref) => ({ ref, releaseVersion: byId.get(ref.testSetId)?.releaseVersion ?? null, state: covered.get(ref.testSetId) ?? ({ kind: "new" } as const) }))
      .sort((a, b) => a.ref.platform.localeCompare(b.ref.platform) || a.ref.testSetName.localeCompare(b.ref.testSetName));
    for (const s of sets) planned.add(s.ref.testSetId);
    const toCompare = sets.filter((s) => s.state.kind === "new").map((s) => s.ref);
    const kinds = new Set(sets.map((s) => s.state.kind));
    const state: ModuleState =
      sets.length === 0 ? "noTestSets" : !kinds.has("new") ? (kinds.has("inDraft") ? "inProgress" : "done") : kinds.size > 1 ? "partly" : "new";
    return { module: name, rows, sets, toCompare, state };
  });
  const workbookModules = new Set([...input.modules.map((m) => moduleKey(m.name)), ...modules.map((m) => moduleKey(m.module))]);
  const outside =
    input.releaseId === null
      ? []
      : input.testSets.filter(
          (t) => t.releaseId === input.releaseId && isMobile(t.name) && !planned.has(t.testSetId) && !workbookModules.has(moduleKey(guessMapping(t.name).module)),
        );
  return { modules, outside: outside.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) };
}
