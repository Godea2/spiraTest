import { handler, ok, parseBody } from "@/lib/server/http";
import { projectLookupSchema } from "@/lib/server/schemas";
import { getProjectName, listReleases, listReportTestSets, listTestSetFolders } from "@/lib/server/spira";
import type { ReportCatalog } from "@/lib/domain/types";

export const maxDuration = 60;

/** Read-only: the project's releases, test set folders and test sets with Spira's counts, for the report. */
export const POST = handler(async (request: Request) => {
  const { projectId } = await parseBody(request, projectLookupSchema);
  const [projectName, releases, [folders, testSets]] = await Promise.all([
    getProjectName(projectId),
    listReleases(projectId),
    listTestSetFolders(projectId).then(async (folders) => [folders, await listReportTestSets(projectId, folders)] as const),
  ]);
  const catalog: ReportCatalog = { projectId, projectName, releases, folders, testSets, readAt: new Date().toISOString() };
  return ok(catalog);
});
