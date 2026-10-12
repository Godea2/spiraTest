import { handler, ok, parseBody } from "@/lib/server/http";
import { reportReleaseCasesRequestSchema } from "@/lib/server/schemas";
import { getReleaseTestCases } from "@/lib/server/spira";
import { inPool } from "@/lib/server/workflow";

export const maxDuration = 60;

const READ_CONCURRENCY = 4;

/** Read-only: the test cases mapped to a release and its sprints, as one list of IDs. */
export const POST = handler(async (request: Request) => {
  const { projectId, releaseIds } = await parseBody(request, reportReleaseCasesRequestSchema);
  const ids = [...new Set(releaseIds)];
  const lists = await inPool(ids, READ_CONCURRENCY, (releaseId) => getReleaseTestCases(projectId, releaseId));
  return ok({ testCaseIds: [...new Set(lists.flat())] });
});
