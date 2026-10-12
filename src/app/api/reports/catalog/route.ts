import { handler, ok, parseBody } from "@/lib/server/http";
import { readReportCatalog } from "@/lib/server/report-live";
import { projectLookupSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Read-only: the project's releases, test set folders and test sets with Spira's counts, for the report. */
export const POST = handler(async (request: Request) => {
  const { projectId } = await parseBody(request, projectLookupSchema);
  return ok(await readReportCatalog(projectId));
});
