import { handler, ok, parseBody } from "@/lib/server/http";
import { reportResultsRequestSchema } from "@/lib/server/schemas";
import { getTestSetResults } from "@/lib/server/spira";
import { inPool } from "@/lib/server/workflow";

export const maxDuration = 60;

const READ_CONCURRENCY = 4;

/** Read-only: the cases in a few test sets with their latest results. */
export const POST = handler(async (request: Request) => {
  const { projectId, testSetIds } = await parseBody(request, reportResultsRequestSchema);
  const ids = [...new Set(testSetIds)];
  const cases = await inPool(ids, READ_CONCURRENCY, (testSetId) => getTestSetResults(projectId, testSetId));
  return ok({ results: Object.fromEntries(ids.map((testSetId, i) => [testSetId, cases[i]])) });
});
