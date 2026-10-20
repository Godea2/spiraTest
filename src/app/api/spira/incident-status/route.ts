import { handler, ok, parseBody } from "@/lib/server/http";
import { incidentStatusUpdateSchema } from "@/lib/server/schemas";
import { updateIncidentStatus } from "@/lib/server/spira";

/** Sets an incident's status in Spira (open, closed, or any workflow status). */
export const POST = handler(async (request: Request) => {
  const { projectId, incidentId, statusId } = await parseBody(request, incidentStatusUpdateSchema);
  return ok(await updateIncidentStatus(projectId, incidentId, statusId));
});
