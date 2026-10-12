import { handler, ok, parseBody } from "@/lib/server/http";
import { readSetResults } from "@/lib/server/report-live";
import { reportResultsRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Read-only: the cases in a few test sets with their latest results. */
export const POST = handler(async (request: Request) => {
  const { projectId, testSetIds } = await parseBody(request, reportResultsRequestSchema);
  return ok({ results: await readSetResults(projectId, testSetIds) });
});
