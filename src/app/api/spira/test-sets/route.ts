import { handler, ok, parseBody } from "@/lib/server/http";
import { testSetListSchema } from "@/lib/server/schemas";
import { listTestSets } from "@/lib/server/spira";

export const maxDuration = 60;

/** Read-only: test sets in the project, optionally only those planned for a release. */
export const POST = handler(async (request: Request) => {
  const { projectId, releaseId } = await parseBody(request, testSetListSchema);
  return ok({ testSets: await listTestSets(projectId, releaseId) });
});
