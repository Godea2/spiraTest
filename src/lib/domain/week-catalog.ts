import { PROD_MATRIX_MODULES } from "@/lib/domain/matrix";
import type { Card, Platform, TestSetComparison } from "@/lib/domain/types";

const EXPECTED_MODULES = PROD_MATRIX_MODULES.map((m) => ({ stem: m.stem, label: m.label }));

/** Collapse &/and and punctuation so near-duplicate module names share one stem. */
export function normalizeModuleStem(name: string): string {
  return name
    .toLowerCase()
    .replace(/\band\b/g, "&")
    .replace(/[^a-z0-9&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Exact / Transfer↔Transfers / &↔and match for module stems. */
export function stemsMatch(a: string, b: string): boolean {
  const na = normalizeModuleStem(a);
  const nb = normalizeModuleStem(b);
  if (na === nb) return true;
  const strip = (s: string) => s.replace(/s\b/g, "").replace(/\s+/g, " ").trim();
  return strip(na) === strip(nb);
}

/** Canonical display label for a module stem when it matches an expected Prod/SIT module. */
export function prettyModuleLabel(module: string): string {
  const stem = normalizeModuleStem(module);
  return EXPECTED_MODULES.find((m) => stemsMatch(m.stem, stem))?.label ?? module.trim();
}

export function isExpectedProdStem(stem: string): boolean {
  const n = normalizeModuleStem(stem);
  return EXPECTED_MODULES.some((m) => stemsMatch(m.stem, n));
}

/** Prefer an already-executed Spira result over Not Run / empty. */
function executionRank(card: Card): number {
  if (card.executed) return 2;
  const status = card.executionStatus.trim().toLowerCase();
  if (!status || status === "not run" || status === "n/a" || status === "not applicable") return 0;
  return 1;
}

/**
 * Keep one membership per testCaseId inside a set.
 * Prefer executed status, then lower testSetTestCaseId for stability.
 */
export function dedupeCardsByTestCaseId(cards: Card[]): Card[] {
  const best = new Map<number, Card>();
  for (const card of cards) {
    const prev = best.get(card.testCaseId);
    if (!prev) {
      best.set(card.testCaseId, card);
      continue;
    }
    const rank = executionRank(card);
    const prevRank = executionRank(prev);
    if (rank > prevRank || (rank === prevRank && card.testSetTestCaseId < prev.testSetTestCaseId)) {
      best.set(card.testCaseId, card);
    }
  }
  return [...best.values()].sort((a, b) => a.testSetTestCaseId - b.testSetTestCaseId);
}

export type WeekModuleDraft = {
  module: string;
  testSets: TestSetComparison[];
  /** True when at least one kept set is planned on the working release. */
  onRelease?: boolean;
};

/**
 * Prefer the working-release set for a module|platform key; only then prefer more cards.
 */
export function preferCatalogSet(
  prev: { comparison: TestSetComparison; onRelease: boolean } | undefined,
  next: { comparison: TestSetComparison; onRelease: boolean },
): boolean {
  if (!prev) return true;
  if (next.onRelease !== prev.onRelease) return next.onRelease;
  return next.comparison.cards.length > prev.comparison.cards.length;
}

/**
 * Drop the same testCaseId on the same platform across modules.
 * Keeps Android+iOS twins. Prefer expected-stem modules, then on-release, then alphabetical module name.
 */
export function dedupeAcrossModulesSamePlatform(modules: WeekModuleDraft[]): WeekModuleDraft[] {
  type Claim = { module: string; platform: Platform; expected: boolean; onRelease: boolean };
  const claims = new Map<string, Claim>();

  const ranked = [...modules].sort((a, b) => {
    const ae = isExpectedProdStem(a.module) ? 1 : 0;
    const be = isExpectedProdStem(b.module) ? 1 : 0;
    if (ae !== be) return be - ae;
    const ar = a.onRelease ? 1 : 0;
    const br = b.onRelease ? 1 : 0;
    if (ar !== br) return br - ar;
    return a.module.localeCompare(b.module);
  });

  for (const mod of ranked) {
    const expected = isExpectedProdStem(mod.module);
    const onRelease = !!mod.onRelease;
    for (const set of mod.testSets) {
      const platform = set.platform;
      if (platform !== "iOS" && platform !== "Android") continue;
      for (const card of set.cards) {
        const key = `${platform}|${card.testCaseId}`;
        if (!claims.has(key)) {
          claims.set(key, { module: mod.module, platform, expected, onRelease });
        }
      }
    }
  }

  return modules
    .map((mod) => {
      const testSets = mod.testSets.map((set) => {
        if (set.platform !== "iOS" && set.platform !== "Android") return set;
        const cards = set.cards.filter((card) => {
          const claim = claims.get(`${set.platform}|${card.testCaseId}`);
          return !claim || claim.module === mod.module;
        });
        if (cards.length === set.cards.length) return set;
        return {
          ...set,
          cards,
          baselineMembership: cards.map((c) => c.testSetTestCaseId).sort((a, b) => a - b),
        };
      });
      return { ...mod, testSets };
    })
    .filter((mod) => mod.testSets.some((s) => s.cards.length > 0));
}
