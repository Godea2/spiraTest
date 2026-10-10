import { guessMapping } from "./settings";
import type { SpiraTestSetSummary } from "./types";

export const moduleKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface TestSetSuggestion {
  /** Test sets whose name starts with the module, ticked ones first. */
  candidates: SpiraTestSetSummary[];
  /** Ticked by default. */
  ticked: Set<number>;
  /** Short explanation per candidate, e.g. its release and any name clash. */
  notes: Map<number, string>;
}

/**
 * Picks a module's test sets from everything in the project. Spira often holds several sets
 * with the same name (one per sprint), so only one per name is ticked: the one planned for
 * the chosen release if there is one, otherwise the newest (highest ID). A set without a
 * platform suffix is not ticked when platform-specific sets exist for the module.
 */
export function suggestTestSets(
  all: SpiraTestSetSummary[],
  module: string,
  alias: string | null,
  releaseId: number | null,
): TestSetSuggestion {
  const keys = new Set([moduleKey(module), alias ? moduleKey(alias) : ""].filter(Boolean));
  const matched = all.filter((t) => keys.has(moduleKey(guessMapping(t.name).module)));

  const byName = new Map<string, SpiraTestSetSummary[]>();
  for (const t of matched) {
    const key = moduleKey(t.name);
    byName.set(key, [...(byName.get(key) ?? []), t]);
  }

  let ticked: SpiraTestSetSummary[] = [];
  for (const group of byName.values()) {
    const inRelease = releaseId === null ? [] : group.filter((t) => t.releaseId === releaseId);
    const pool = inRelease.length ? inRelease : releaseId !== null && hasAnyInRelease(matched, releaseId) ? [] : group;
    if (pool.length) ticked.push(pool.reduce((a, b) => (b.testSetId > a.testSetId ? b : a)));
  }
  if (ticked.some((t) => guessMapping(t.name).platform !== "Other")) {
    ticked = ticked.filter((t) => guessMapping(t.name).platform !== "Other");
  }
  const tickedIds = new Set(ticked.map((t) => t.testSetId));

  const notes = new Map<number, string>();
  for (const t of matched) {
    const parts = [t.releaseVersion ? `Release ${t.releaseVersion}` : "No release"];
    const twins = (byName.get(moduleKey(t.name)) ?? []).filter((o) => o.testSetId !== t.testSetId);
    if (twins.length) parts.push(`same name as ${twins.map((o) => `TX${o.testSetId}`).join(", ")}`);
    notes.set(t.testSetId, parts.join(" · "));
  }

  const candidates = [...matched].sort(
    (a, b) =>
      Number(tickedIds.has(b.testSetId)) - Number(tickedIds.has(a.testSetId)) ||
      a.name.localeCompare(b.name, undefined, { numeric: true }) ||
      b.testSetId - a.testSetId,
  );
  return { candidates, ticked: tickedIds, notes };
}

function hasAnyInRelease(sets: SpiraTestSetSummary[], releaseId: number) {
  return sets.some((t) => t.releaseId === releaseId);
}
