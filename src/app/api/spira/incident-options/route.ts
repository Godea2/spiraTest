import { handler, ok, parseBody } from "@/lib/server/http";
import { projectLookupSchema } from "@/lib/server/schemas";
import { getIncidentOptions } from "@/lib/server/spira";

/** Read-only: the project's incident types, priorities, severities and statuses. */
export const POST = handler(async (request: Request) => {
  const { projectId } = await parseBody(request, projectLookupSchema);
  return ok(await getIncidentOptions(projectId));
});
