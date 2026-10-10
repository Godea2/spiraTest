import { handler, ok, parseBody } from "@/lib/server/http";
import { releaseLookupSchema } from "@/lib/server/schemas";
import { getRelease } from "@/lib/server/spira";

/** Read-only: the release's version number and name, for the label on boards. */
export const POST = handler(async (request: Request) => {
  const { projectId, releaseId } = await parseBody(request, releaseLookupSchema);
  return ok(await getRelease(projectId, releaseId));
});
