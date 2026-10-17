import "server-only";
import { cardKey } from "@/lib/domain/board";
import { CYCLE_PRESETS, detectCycle, findCycleFolder, guessMapping, type CycleId } from "@/lib/domain/settings";
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
  /** Spira folder used, when Week loaded by folder (e.g. UAT - Phase 1). */
  folderName: string | null;
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

async function listWeekTestSets(
  projectId: number,
  releaseId: number,
  cycleId: CycleId | null,
): Promise<{ sets: SpiraTestSetSummary[]; folderName: string | null }> {
  if (cycleId) {
    const folderName = CYCLE_PRESETS[cycleId].folderName;
    const folders = await listTestSetFolders(projectId);
    const folder = findCycleFolder(folders, folderName);
    if (folder) {
      // Folder first (what you see in Spira). No release_id filter — the UI lists the whole folder.
      const inFolder = await listTestSetsInFolder(projectId, folder.folderId, null);
      if (inFolder.length) return { sets: inFolder, folderName: folder.name };
    }
  }
  return { sets: await listTestSets(projectId, releaseId), folderName: null };
}

/**
 * Reads Spira test sets for the working cycle (UAT - Phase 1 folder when on UAT; else the release),
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
      : input.releaseId === CYCLE_PRESETS.sit.releaseId || /1\.0\.0\.0002/.test(input.releaseLabel)
        ? "sit"
        : detectCycle(input.releaseId, []);

  const { sets: listed, folderName } = await listWeekTestSets(input.projectId, input.releaseId, cycleId);
  const mobile = listed.filter((t) => !/\bapi\b/i.test(t.name));
  if (mobile.length === 0) {
    throw new HttpError(
      400,
      folderName
        ? `No mobile test sets in Spira folder "${folderName}".`
        : `No mobile test sets are planned for release ${input.releaseLabel || input.releaseId} in Spira.`,
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
