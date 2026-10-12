import { handler, ok, parseBody } from "@/lib/server/http";
import { projectLookupSchema } from "@/lib/server/schemas";
import { listIncidents } from "@/lib/server/spira";

export const maxDuration = 60;

/** Read-only: the project's incidents with status, severity, priority and dates. */
export const POST = handler(async (request: Request) => {
  const { projectId } = await parseBody(request, projectLookupSchema);
  return ok(await listIncidents(projectId));
});
