import "server-only";
import { cardKey } from "@/lib/domain/board";
import { CYCLE_PRESETS, detectCycle, findCycleFolder, guessMapping, isMobileWeekSet, type CycleId } from "@/lib/domain/settings";
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

function folderSubtreeIds(
  folders: Array<{ folderId: number; parentId: number | null; name: string }>,
  rootId: number,
): number[] {
  const kids = folders.filter((f) => f.parentId === rootId);
  return [rootId, ...kids.flatMap((k) => folderSubtreeIds(folders, k.folderId))];
}

async function listWeekTestSets(
  projectId: number,
  releaseId: number,
  cycleId: CycleId | null,
  releaseLabel: string,
): Promise<{ sets: SpiraTestSetSummary[]; folderName: string | null; source: "release" | "folder" }> {
  // Union three Spira cuts so Prod Matrix gets every module (Accounts…Transfers × iOS/Android):
  // 1) release_id filter, 2) cycle folder tree, 3) all project sets whose version matches the label.
  const onRelease = (await listTestSets(projectId, releaseId)).filter((t) => isMobileWeekSet(t.name));
  const byId = new Map(onRelease.map((t) => [t.testSetId, t]));
  let folderName: string | null = null;

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
        for (const t of inFolder) byId.set(t.testSetId, t);
      }
    }
  }

  const versionToken = (
    (cycleId ? CYCLE_PRESETS[cycleId].versionNumber : "") ||
    releaseLabel ||
    ""
  ).match(/1\.0\.0(?:\.0)?\.\d+/)?.[0];
  // Always union by version so a module present on only one platform cut (e.g. Transfers Android)
  // is not dropped when folder/release already returned 12+ other sets.
  if (versionToken) {
    const all = await listTestSets(projectId, null);
    for (const t of all) {
      if (!isMobileWeekSet(t.name)) continue;
      const ver = t.releaseVersion || "";
      if (ver.includes(versionToken) || (ver.length > 0 && releaseLabel.includes(ver))) {
        byId.set(t.testSetId, t);
      }
    }
  }

  // Pair missing counterparts: if we have "Transfers - iOS" but not Android (or vice versa), pull it.
  const loaded = [...byId.values()];
  const byStem = new Map<string, { ios: boolean; android: boolean }>();
  for (const t of loaded) {
    const { module, platform } = guessMapping(t.name);
    const stem = module.toLowerCase();
    const row = byStem.get(stem) ?? { ios: false, android: false };
    if (platform === "iOS") row.ios = true;
    if (platform === "Android") row.android = true;
    byStem.set(stem, row);
  }
  const needsPair = [...byStem.entries()].some(([, p]) => p.ios !== p.android);
  if (needsPair) {
    const all = await listTestSets(projectId, null);
    for (const t of all) {
      if (!isMobileWeekSet(t.name) || byId.has(t.testSetId)) continue;
      const { module, platform } = guessMapping(t.name);
      if (platform !== "iOS" && platform !== "Android") continue;
      const pair = byStem.get(module.toLowerCase());
      if (!pair) continue;
      if ((platform === "iOS" && !pair.ios) || (platform === "Android" && !pair.android)) {
        byId.set(t.testSetId, t);
      }
    }
  }

  const sets = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sets.length === 0) return { sets: [], folderName: null, source: "release" };
  const source = folderName && onRelease.length === 0 ? "folder" : "release";
  return { sets, folderName, source };
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

  const { sets: mobile, folderName, source } = await listWeekTestSets(
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
    const ctx: WorkflowContext = { projectId: input.projectId, releaseId: input.releaseId, module };
    const cards = cases.map((c) => caseCard(t.testSetId, c));
    const comparison = sealComparison(ctx, {
      testSetId: t.testSetId,
      testSetName: t.name,
      platform,
      comparedAt: new Date().toISOString(),
      cards,
      missingFromSpira: [],
      baselineMembership: cards.map((c) => c.testSetTestCaseId).sort((a, b) => a - b),
    });
    return { module, comparison };
  });

  const byModule = new Map<string, TestSetComparison[]>();
  for (const row of loaded) {
    byModule.set(row.module, [...(byModule.get(row.module) ?? []), row.comparison]);
  }

  const modules: WeekModule[] = [...byModule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([module, testSets]) => ({
      module,
      context: { projectId: input.projectId, releaseId: input.releaseId, module },
      testSets,
      caseCount: testSets.reduce((n, s) => n + s.cards.length, 0),
    }));

  return {
    projectId: input.projectId,
    releaseId: input.releaseId,
    releaseLabel: input.releaseLabel,
    folderName,
    source,
    modules,
    testSetCount: mobile.length,
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
