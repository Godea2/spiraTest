import { handler, ok, parseBody } from "@/lib/server/http";
import { incidentDescriptionLookupSchema, incidentDescriptionUpdateSchema } from "@/lib/server/schemas";
import { getIncidentDescription, updateIncidentDescription } from "@/lib/server/spira";

/** Read-only: plain-text incident description. */
export const POST = handler(async (request: Request) => {
  const { projectId, incidentId } = await parseBody(request, incidentDescriptionLookupSchema);
  return ok(await getIncidentDescription(projectId, incidentId));
});

/** Replaces the incident description in Spira. */
export const PUT = handler(async (request: Request) => {
  const { projectId, incidentId, description } = await parseBody(request, incidentDescriptionUpdateSchema);
  return ok(await updateIncidentDescription(projectId, incidentId, description));
});
