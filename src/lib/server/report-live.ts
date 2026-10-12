import "server-only";
import { buildReport, resolveReportOptions, type Report, type ReportOptions } from "@/lib/domain/report";
import { collectReportData } from "@/lib/domain/report-read";
import type { ReportCatalog, ReportIncident, TestSetMapping } from "@/lib/domain/types";
import { getProjectName, getTestSetResults, incidentsForTestCase, listIncidents, listReleases, listReportTestSets, listTestSetFolders } from "./spira";
import { inPool } from "./workflow";

const SET_CONCURRENCY = 4;
const LINK_CONCURRENCY = 5;

/** Read-only: the project's releases, test set folders and test sets with Spira's counts. */
export async function readReportCatalog(projectId: number): Promise<ReportCatalog> {
  const [projectName, releases, [folders, testSets]] = await Promise.all([
    getProjectName(projectId),
    listReleases(projectId),
    listTestSetFolders(projectId).then(async (folders) => [folders, await listReportTestSets(projectId, folders)] as const),
  ]);
  return { projectId, projectName, releases, folders, testSets, readAt: new Date().toISOString() };
}

/** Read-only: the cases in a few test sets with their latest results. */
export async function readSetResults(projectId: number, testSetIds: number[]) {
  const ids = [...new Set(testSetIds)];
  const cases = await inPool(ids, SET_CONCURRENCY, (testSetId) => getTestSetResults(projectId, testSetId));
  return Object.fromEntries(ids.map((testSetId, i) => [testSetId, cases[i]]));
}

/** Read-only: the incidents linked to each of a few test cases, through their runs or steps. */
export async function readCaseLinks(projectId: number, testCaseIds: number[]) {
  const ids = [...new Set(testCaseIds)];
  const found = await inPool(ids, LINK_CONCURRENCY, (testCaseId) => incidentsForTestCase(projectId, testCaseId));
  const incidents = new Map<number, ReportIncident>();
  for (const list of found) for (const incident of list) incidents.set(incident.incidentId, incident);
  return {
    links: Object.fromEntries(ids.map((testCaseId, i) => [testCaseId, found[i].map((incident) => incident.incidentId)])),
    incidents: [...incidents.values()],
  };
}

/** The whole report, read live from Spira on the server. */
export async function readLiveReport(projectId: number, options: ReportOptions, mappings: TestSetMapping[]): Promise<Report> {
  const catalog = await readReportCatalog(projectId);
  const input = await collectReportData({
    catalog,
    options: resolveReportOptions(options),
    mappings,
    workers: 2,
    reader: {
      results: (ids) => readSetResults(projectId, ids),
      links: (ids) => readCaseLinks(projectId, ids),
      incidents: () => listIncidents(projectId),
    },
  });
  return buildReport(input);
}
