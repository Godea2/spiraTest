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

  options.onProgress?.(0, picks.length);
  if (options.keepGoing && !options.keepGoing()) {
    return { results: [], recorded: 0, failed: picks.map((p) => ({ testCaseId: p.target.card.testCaseId, message: "Stopped before it was recorded." })) };
  }

  try {
    const out = await api<{ results: ExecutionResult[] }>("/api/week/record", {
      method: "POST",
      body: { catalog, tester, batches },
    });
    options.onProgress?.(picks.length, picks.length);
    const failed = out.results.filter((r) => r.result !== "recorded").map((r) => ({ testCaseId: r.testCaseId, message: r.message ?? r.result }));
    return { results: out.results, recorded: out.results.filter((r) => r.result === "recorded").length, failed };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Recording failed.";
    return { results: [], recorded: 0, failed: picks.map((p) => ({ testCaseId: p.target.card.testCaseId, message })) };
  }
}
