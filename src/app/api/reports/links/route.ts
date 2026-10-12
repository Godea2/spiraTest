import { handler, ok, parseBody } from "@/lib/server/http";
import { readCaseLinks } from "@/lib/server/report-live";
import { reportLinksRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Read-only: the incidents linked to each of a few test cases, through their runs or steps. */
export const POST = handler(async (request: Request) => {
  const { projectId, testCaseIds } = await parseBody(request, reportLinksRequestSchema);
  return ok(await readCaseLinks(projectId, testCaseIds));
});
