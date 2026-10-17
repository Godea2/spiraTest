import "server-only";
import { cardKey } from "@/lib/domain/board";
import { guessMapping } from "@/lib/domain/settings";
import type { Card, ExecutionCaseInput, ExecutionResult, TestSetComparison, WorkflowContext } from "@/lib/domain/types";
import { inPool, recordExecutions } from "./workflow";
import { sealComparison } from "./seal";
import { HttpError } from "./http";
import { getTestSetCases, listTestSets } from "./spira";

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

/**
 * Reads every test set planned for the working release, groups them by module name, and seals
 * boards with every case In Scope so weekly Excel results can be recorded without Compare.
 */
export async function loadWeekCatalog(input: {
  projectId: number;
  releaseId: number;
  releaseLabel: string;
}): Promise<WeekCatalog> {
  const listed = await listTestSets(input.projectId, input.releaseId);
  const mobile = listed.filter((t) => !/\bapi\b/i.test(t.name));
  if (mobile.length === 0) {
    throw new HttpError(400, `No mobile test sets are planned for release ${input.releaseLabel || input.releaseId} in Spira.`);
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
