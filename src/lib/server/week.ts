import "server-only";
import { cardKey } from "@/lib/domain/board";
import { PROD_MATRIX_MODULES } from "@/lib/domain/matrix";
import { CYCLE_PRESETS, detectCycle, findCycleFolder, guessMapping, isMobileWeekSet, type CycleId } from "@/lib/domain/settings";
import {
  dedupeAcrossModulesSamePlatform,
  dedupeCardsByTestCaseId,
  isExpectedProdStem,
  normalizeModuleStem,
  preferCatalogSet,
  prettyModuleLabel,
  stemsMatch,
} from "@/lib/domain/week-catalog";
import type { Card, ExecutionCaseInput, ExecutionResult, SpiraTestSetSummary, TestSetComparison, WorkflowContext } from "@/lib/domain/types";
import { inPool, recordExecutions } from "./workflow";
import { sealComparison } from "./seal";
import { HttpError } from "./http";
import { getTestSetCases, listTestSetFolders, listTestSets, listTestSetsInFolder } from "./spira";

export interface WeekModule {
  module: string;
  context: WorkflowContext;
  testSets: TestSetComparison[];
  caseCount: number;
}

export interface WeekCatalog {
  projectId: number;
  releaseId: number;
  releaseLabel: string;
  /** Spira folder used only when falling back from the release plan (e.g. UAT - Phase 1). */
  folderName: string | null;
  /** How the catalog was chosen: release plan (same basis as Reports this-build) or folder fallback. */
  source: "release" | "folder";
  modules: WeekModule[];
  testSetCount: number;
  caseCount: number;
}

function caseCard(testSetId: number, c: Awaited<ReturnType<typeof getTestSetCases>>[number]): Card {
  return {
    key: cardKey(testSetId, c.testSetTestCaseId),
    testSetId,
    testCaseId: c.testCaseId,
    testSetTestCaseId: c.testSetTestCaseId,
    name: c.name,
    tcId: null,
    executionStatus: c.executionStatus,
    executed: c.executed,
    suggestion: "inScope",
    reason: "On the Spira test set for this build.",
  };
}

const EXPECTED_MOBILE_STEMS = PROD_MATRIX_MODULES.map((m) => m.stem);

function folderSubtreeIds(
  folders: Array<{ folderId: number; parentId: number | null; name: string }>,
  rootId: number,
): number[] {
  const kids = folders.filter((f) => f.parentId === rootId);
  return [rootId, ...kids.flatMap((k) => folderSubtreeIds(folders, k.folderId))];
}

function moduleStem(name: string): { stem: string; platform: "iOS" | "Android" | "Other" } {
  const { module, platform } = guessMapping(name);
  const stem = normalizeModuleStem(module);
  if (platform === "iOS" || platform === "Android") return { stem, platform };
  return { stem, platform: "Other" };
}

function versionMatches(set: SpiraTestSetSummary, versionToken: string | undefined, releaseLabel: string): boolean {
  if (!versionToken) return false;
  const ver = set.releaseVersion || "";
  return ver.includes(versionToken) || (ver.length > 0 && releaseLabel.includes(ver));
}

async function listWeekTestSets(
  projectId: number,
  releaseId: number,
  cycleId: CycleId | null,
  releaseLabel: string,
): Promise<{
  sets: SpiraTestSetSummary[];
  folderName: string | null;
  source: "release" | "folder";
  onReleaseIds: Set<number>;
}> {
  // Prod cut: release plan + cycle folder + same version number only.
  // Do not pull every fuzzy name match from the whole project (that mixed SIT/UAT into Matrix).
  const onRelease = (await listTestSets(projectId, releaseId)).filter((t) => isMobileWeekSet(t.name));
  const onReleaseIds = new Set(onRelease.map((t) => t.testSetId));
  const byId = new Map(onRelease.map((t) => [t.testSetId, t]));
  let folderName: string | null = null;
  const folderSetIds = new Set<number>();

  if (cycleId) {
    const wantFolder = CYCLE_PRESETS[cycleId].folderName;
    const folders = await listTestSetFolders(projectId);
    const folder = findCycleFolder(folders, wantFolder);
    if (folder) {
      folderName = folder.name;
      for (const folderId of folderSubtreeIds(folders, folder.folderId)) {
        const inFolder = (await listTestSetsInFolder(projectId, folderId, null)).filter((t) =>
          isMobileWeekSet(t.name),
        );
        for (const t of inFolder) {
          byId.set(t.testSetId, t);
          folderSetIds.add(t.testSetId);
        }
      }
    }
  }

  const versionToken = (
    (cycleId ? CYCLE_PRESETS[cycleId].versionNumber : "") ||
    releaseLabel ||
    ""
  ).match(/1\.0\.0(?:\.0)?\.\d+/)?.[0];

  const allMobile = (await listTestSets(projectId, null)).filter((t) => isMobileWeekSet(t.name));
  if (versionToken) {
    for (const t of allMobile) {
      if (versionMatches(t, versionToken, releaseLabel)) byId.set(t.testSetId, t);
    }
  }

  // Missing platform pair for an expected Prod module (e.g. Transfers Android): only add a
  // counterpart that is on the same version or already in the cycle folder.
  const present = new Map<string, { ios: boolean; android: boolean }>();
  for (const t of byId.values()) {
    const { stem, platform } = moduleStem(t.name);
    if (!isExpectedProdStem(stem) || platform === "Other") continue;
    const row = present.get(stem) ?? { ios: false, android: false };
    if (platform === "iOS") row.ios = true;
    if (platform === "Android") row.android = true;
    present.set(stem, row);
  }
  for (const want of EXPECTED_MOBILE_STEMS) {
    const row = [...present.entries()].find(([stem]) => stemsMatch(stem, want))?.[1] ?? {
      ios: false,
      android: false,
    };
    for (const need of ["iOS", "Android"] as const) {
      if ((need === "iOS" && row.ios) || (need === "Android" && row.android)) continue;
      const candidate = allMobile.find((t) => {
        if (byId.has(t.testSetId)) return false;
        const { stem, platform } = moduleStem(t.name);
        if (platform !== need || !stemsMatch(stem, want)) return false;
        return folderSetIds.has(t.testSetId) || versionMatches(t, versionToken, releaseLabel);
      });
      if (candidate) byId.set(candidate.testSetId, candidate);
    }
  }

  const sets = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sets.length === 0) return { sets: [], folderName: null, source: "release", onReleaseIds };
  const source = folderName && onRelease.length === 0 ? "folder" : "release";
  return { sets, folderName, source, onReleaseIds };
}

/**
 * Reads Spira iOS/Android test sets planned for the working release (same basis as Reports this-build),
 * groups them by module, and seals boards so weekly Excel can be recorded without Compare.
 */
export async function loadWeekCatalog(input: {
  projectId: number;
  releaseId: number;
  releaseLabel: string;
}): Promise<WeekCatalog> {
  // Soft detect from version / known RL ids (no full release list needed on the server).
  const cycleId: CycleId | null =
    input.releaseId === CYCLE_PRESETS.uat.releaseId || /1\.0\.0\.0\.0004/.test(input.releaseLabel)
      ? "uat"
      : /1\.0\.0\.0\.0006/.test(input.releaseLabel)
        ? "prod"
        : input.releaseId === CYCLE_PRESETS.sit.releaseId || /1\.0\.0\.0002/.test(input.releaseLabel)
          ? "sit"
          : detectCycle(input.releaseId, []);

  const { sets: mobile, folderName, source, onReleaseIds } = await listWeekTestSets(
    input.projectId,
    input.releaseId,
    cycleId,
    input.releaseLabel,
  );
  if (mobile.length === 0) {
    throw new HttpError(
      400,
      `No iOS/Android test sets are planned for release ${input.releaseLabel || input.releaseId} in Spira.`,
    );
  }

  const loaded = await inPool(mobile, 4, async (t) => {
    const cases = await getTestSetCases(input.projectId, t.testSetId);
    const { module, platform } = guessMapping(t.name);
    const pretty = prettyModuleLabel(module);
    const cards = dedupeCardsByTestCaseId(cases.map((c) => caseCard(t.testSetId, c)));
    // Seal under the canonical module label so Execute / Pass verify against the draft context.
    const ctx: WorkflowContext = { projectId: input.projectId, releaseId: input.releaseId, module: pretty };
    const comparison = sealComparison(ctx, {
      testSetId: t.testSetId,
      testSetName: t.name,
      platform,
      comparedAt: new Date().toISOString(),
      cards,
      missingFromSpira: [],
      baselineMembership: cards.map((c) => c.testSetTestCaseId).sort((a, b) => a - b),
    });
    return { module: pretty, comparison, onRelease: onReleaseIds.has(t.testSetId) };
  });

  // Per module + platform: prefer the working-release set, then the richest set.
  // For Prod/UAT, only keep the expected seven module stems so SIT leftovers never appear.
  const restrictToExpected = cycleId === "prod" || cycleId === "uat";
  const bestByKey = new Map<string, { module: string; comparison: TestSetComparison; onRelease: boolean }>();
  for (const row of loaded) {
    if (row.comparison.platform !== "iOS" && row.comparison.platform !== "Android") continue;
    const stem = normalizeModuleStem(row.module);
    if (restrictToExpected && !isExpectedProdStem(stem)) continue;
    const key = `${normalizeModuleStem(row.module)}|${row.comparison.platform}`;
    const prev = bestByKey.get(key);
    if (preferCatalogSet(prev, { comparison: row.comparison, onRelease: row.onRelease })) {
      bestByKey.set(key, { module: row.module, comparison: row.comparison, onRelease: row.onRelease });
    }
  }

  const byModule = new Map<string, { testSets: TestSetComparison[]; onRelease: boolean }>();
  for (const row of bestByKey.values()) {
    const prev = byModule.get(row.module);
    byModule.set(row.module, {
      testSets: [...(prev?.testSets ?? []), row.comparison],
      onRelease: !!(prev?.onRelease || row.onRelease),
    });
  }

  const drafted = dedupeAcrossModulesSamePlatform(
    [...byModule.entries()].map(([module, row]) => ({
      module,
      testSets: row.testSets.sort((a, b) => a.platform.localeCompare(b.platform)),
      onRelease: row.onRelease,
    })),
  );

  // Re-seal after cross-module card drops so Pass still verifies.
  const modules: WeekModule[] = drafted
    .sort((a, b) => a.module.localeCompare(b.module))
    .map((row) => {
      const ctx: WorkflowContext = { projectId: input.projectId, releaseId: input.releaseId, module: row.module };
      const testSets = row.testSets.map((set) =>
        sealComparison(ctx, {
          testSetId: set.testSetId,
          testSetName: set.testSetName,
          platform: set.platform,
          comparedAt: set.comparedAt,
          cards: set.cards,
          missingFromSpira: set.missingFromSpira,
          baselineMembership: set.cards.map((c) => c.testSetTestCaseId).sort((a, b) => a - b),
        }),
      );
      return {
        module: row.module,
        context: ctx,
        testSets,
        caseCount: testSets.reduce((n, s) => n + s.cards.length, 0),
      };
    });

  return {
    projectId: input.projectId,
    releaseId: input.releaseId,
    releaseLabel: input.releaseLabel,
    folderName,
    source,
    modules,
    testSetCount: modules.reduce((n, m) => n + m.testSets.length, 0),
    caseCount: modules.reduce((n, m) => n + m.caseCount, 0),
  };
}

export interface WeekRecordBatch {
  module: string;
  testSetId: number;
  cases: ExecutionCaseInput[];
}

/**
 * Records runs against the sealed week boards (no draft / Compare). Tester is written on each run.
 */
export async function recordWeekRuns(input: {
  catalog: WeekCatalog;
  tester: string;
  batches: WeekRecordBatch[];
}): Promise<{ results: ExecutionResult[] }> {
  const byModule = new Map(input.catalog.modules.map((m) => [m.module, m]));
  const results: ExecutionResult[] = [];
  for (const batch of input.batches) {
    const mod = byModule.get(batch.module);
    if (!mod) throw new HttpError(400, `Module "${batch.module}" is not in the loaded week catalog.`);
    const out = await recordExecutions({
      context: mod.context,
      testSets: mod.testSets,
      decisions: {},
      draftName: `Week · ${input.catalog.releaseLabel}`,
      tester: input.tester,
      batch: { testSetId: batch.testSetId, cases: batch.cases },
    });
    results.push(...out.results);
  }
  return { results };
}
