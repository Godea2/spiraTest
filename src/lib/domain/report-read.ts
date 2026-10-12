import { EXECUTION_STATUS } from "./execution";
import { MAX_LINKED_CASES, MAX_REPORT_LINKS, MAX_REPORT_SETS, setsInScope, type ReportInput, type ReportOptions } from "./report";
import type { ReportCase, ReportCatalog, ReportIncident, TestSetMapping } from "./types";

export interface ReportProgress {
  step: string;
  done: number;
  total: number;
}

/** Read-only access to Spira for a report: through the API routes in the browser, directly on the server. */
export interface ReportReader {
  results(testSetIds: number[]): Promise<Record<number, ReportCase[]>>;
  links(testCaseIds: number[]): Promise<{ links: Record<number, number[]>; incidents: ReportIncident[] }>;
  incidents(): Promise<{ incidents: ReportIncident[]; complete: boolean }>;
}

async function inBatches<T>(items: T[], size: number, workers: number, run: (batch: T[]) => Promise<void>): Promise<void> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, batches.length) }, async () => {
      while (next < batches.length) await run(batches[next++]);
    }),
  );
}

const LINK_STATUSES = new Set<number>([EXECUTION_STATUS.failed, EXECUTION_STATUS.blocked, EXECUTION_STATUS.caution]);

/**
 * Everything the report needs: the cases of every test set in both scopes, the project's incidents, and
 * the incidents linked to each failed, blocked or caution case in this build.
 */
export async function collectReportData(input: {
  catalog: ReportCatalog;
  options: ReportOptions;
  mappings: TestSetMapping[];
  reader: ReportReader;
  workers?: number;
  onProgress?: (progress: ReportProgress) => void;
}): Promise<ReportInput> {
  const { catalog, options, reader } = input;
  const workers = input.workers ?? 3;
  const progress = input.onProgress ?? (() => undefined);
  const scopedSets = setsInScope(catalog, options.scoped);
  const baselineSets = setsInScope(catalog, options.baseline);
  const setIds = [...new Set([...scopedSets, ...baselineSets].map((s) => s.testSetId))];

  const incidentsRead = reader.incidents();
  incidentsRead.catch(() => undefined);

  const results: Record<number, ReportCase[]> = {};
  progress({ step: "Reading test sets", done: 0, total: setIds.length });
  await inBatches(setIds, MAX_REPORT_SETS, workers, async (batch) => {
    Object.assign(results, await reader.results(batch));
    progress({ step: "Reading test sets", done: Object.keys(results).length, total: setIds.length });
  });

  // Failed cases first, so the link check covers them before blocked and caution ones.
  const failed = new Set<number>();
  const others = new Set<number>();
  for (const set of scopedSets) {
    for (const c of results[set.testSetId] ?? []) {
      if (c.statusId === EXECUTION_STATUS.failed) failed.add(c.testCaseId);
      else if (c.statusId !== null && LINK_STATUSES.has(c.statusId)) others.add(c.testCaseId);
    }
  }
  const toLink = [...failed, ...[...others].filter((id) => !failed.has(id))].slice(0, MAX_LINKED_CASES);

  const links: Record<number, number[]> = {};
  const linked = new Map<number, ReportIncident>();
  progress({ step: "Checking defects linked to failures", done: 0, total: toLink.length });
  await inBatches(toLink, MAX_REPORT_LINKS, workers, async (batch) => {
    const out = await reader.links(batch);
    Object.assign(links, out.links);
    for (const incident of out.incidents) linked.set(incident.incidentId, incident);
    progress({ step: "Checking defects linked to failures", done: Object.keys(links).length, total: toLink.length });
  });

  progress({ step: "Reading incidents", done: 0, total: 1 });
  const { incidents, complete } = await incidentsRead;
  const all = new Map(incidents.map((i) => [i.incidentId, i]));
  for (const [id, incident] of linked) all.set(id, incident);

  return {
    catalog,
    options,
    mappings: input.mappings,
    results,
    incidents: [...all.values()],
    incidentsComplete: complete,
    links,
    generatedAt: new Date().toISOString(),
  };
}
