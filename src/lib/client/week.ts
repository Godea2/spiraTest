import { chunk } from "@/lib/domain/board";
import { MAX_EXECUTION_BATCH } from "@/lib/domain/execution";
import type { Draft, ExecutionResult, TestSetComparison } from "@/lib/domain/types";
import { api } from "./api";
import type { ProgressPick } from "./progress";

export interface WeekModule {
  module: string;
  context: { projectId: number; releaseId: number | null; module: string };
  testSets: TestSetComparison[];
  caseCount: number;
}

export interface WeekCatalog {
  projectId: number;
  releaseId: number;
  releaseLabel: string;
  folderName: string | null;
  /** Release plan (Reports this-build) or folder fallback. */
  source: "release" | "folder";
  modules: WeekModule[];
  testSetCount: number;
  caseCount: number;
}

/** Loads sealed boards for the Settings working release (UAT when that cycle is selected). */
export function loadWeekCatalog(projectId: number, releaseId: number, releaseLabel: string): Promise<WeekCatalog> {
  return api<WeekCatalog>("/api/week/catalog", {
    method: "POST",
    body: { projectId, releaseId, releaseLabel },
  });
}

/** In-memory drafts so Progress import / Gemini search can run without Compare. Not saved. */
export function weekCatalogAsDrafts(catalog: WeekCatalog): Draft[] {
  const now = new Date().toISOString();
  return catalog.modules.map((m) => ({
    id: `week:${m.module}`,
    name: `${m.module} · ${catalog.releaseLabel}`,
    module: m.module,
    projectId: catalog.projectId,
    releaseId: catalog.releaseId,
    releaseLabel: catalog.releaseLabel,
    status: "applied" as const,
    createdAt: now,
    updatedAt: now,
    source: { fileName: "Spira week catalog", inScopeSheet: "Spira", needsConfirmationSheet: null },
    rows: [],
    testSetIds: m.testSets.map((s) => s.testSetId),
    testSetRefs: m.testSets.map((s) => ({ testSetId: s.testSetId, testSetName: s.testSetName, platform: s.platform })),
    testSets: m.testSets,
    compareErrors: {},
    decisions: {},
    history: [],
    apply: {
      preflight: null,
      removed: {},
      failed: {},
      verification: null,
      lastLiveRunAt: null,
      lastDryRunAt: null,
      completedWithoutChanges: now,
    },
  }));
}

export interface WeekRecordOutcome {
  results: ExecutionResult[];
  recorded: number;
  failed: Array<{ testCaseId: number; message: string }>;
}

/** Records picks against the week catalog (tester name goes on each Spira run). */
export async function recordWeekPicks(
  catalog: WeekCatalog,
  picks: ProgressPick[],
  tester: string,
  options: { onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean } = {},
): Promise<WeekRecordOutcome> {
  const batches: Array<{
    module: string;
    testSetId: number;
    cases: Array<{ testCaseId: number; testSetTestCaseId: number; status: ProgressPick["status"]; comment: string; steps: [] }>;
  }> = [];
  const byKey = new Map<string, ProgressPick[]>();
  for (const p of picks) {
    const key = `${p.target.module}|${p.target.card.testSetId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  for (const group of byKey.values()) {
    for (const slice of chunk(group, MAX_EXECUTION_BATCH)) {
      batches.push({
        module: slice[0].target.module,
        testSetId: slice[0].target.card.testSetId,
        cases: slice.map((p) => ({
          testCaseId: p.target.card.testCaseId,
          testSetTestCaseId: p.target.card.testSetTestCaseId,
          status: p.status,
          comment: p.comment.trim(),
          steps: [],
        })),
      });
    }
  }

  // One small request per batch — a single POST with the full catalog + 374 runs times out on Vercel
  // and never moves the progress bar off "0 of 374".
  const results: ExecutionResult[] = [];
  const failed: Array<{ testCaseId: number; message: string }> = [];
  let done = 0;
  options.onProgress?.(0, picks.length);

  for (const batch of batches) {
    if (options.keepGoing && !options.keepGoing()) {
      for (const c of batch.cases) failed.push({ testCaseId: c.testCaseId, message: "Stopped before it was recorded." });
      done += batch.cases.length;
      options.onProgress?.(done, picks.length);
      continue;
    }

    const mod = catalog.modules.find((m) => m.module === batch.module);
    if (!mod) {
      for (const c of batch.cases) failed.push({ testCaseId: c.testCaseId, message: `Module "${batch.module}" is not in the loaded week catalog.` });
      done += batch.cases.length;
      options.onProgress?.(done, picks.length);
      continue;
    }

    const slim: WeekCatalog = {
      ...catalog,
      modules: [mod],
      testSetCount: mod.testSets.length,
      caseCount: mod.caseCount,
    };

    try {
      const out = await api<{ results: ExecutionResult[] }>("/api/week/record", {
        method: "POST",
        body: { catalog: slim, tester, batches: [batch] },
      });
      for (const r of out.results) {
        results.push(r);
        if (r.result !== "recorded") failed.push({ testCaseId: r.testCaseId, message: r.message ?? r.result });
      }
      // Cases the server omitted (should not happen) count as failed so progress stays honest.
      for (const c of batch.cases) {
        if (!out.results.some((r) => r.testSetTestCaseId === c.testSetTestCaseId && r.testSetId === batch.testSetId)) {
          failed.push({ testCaseId: c.testCaseId, message: "No result returned from Spira for this case." });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Recording failed.";
      for (const c of batch.cases) failed.push({ testCaseId: c.testCaseId, message });
    }

    done += batch.cases.length;
    options.onProgress?.(done, picks.length);
  }

  return {
    results,
    recorded: results.filter((r) => r.result === "recorded").length,
    failed,
  };
}
