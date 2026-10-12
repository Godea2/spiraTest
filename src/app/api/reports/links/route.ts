import type { ReportIncident } from "@/lib/domain/types";
import { handler, ok, parseBody } from "@/lib/server/http";
import { reportLinksRequestSchema } from "@/lib/server/schemas";
import { incidentsForTestCase } from "@/lib/server/spira";
import { inPool } from "@/lib/server/workflow";

export const maxDuration = 60;

const READ_CONCURRENCY = 5;

/** Read-only: the incidents linked to each of a few test cases, through their runs or steps. */
export const POST = handler(async (request: Request) => {
  const { projectId, testCaseIds } = await parseBody(request, reportLinksRequestSchema);
  const ids = [...new Set(testCaseIds)];
  const found = await inPool(ids, READ_CONCURRENCY, (testCaseId) => incidentsForTestCase(projectId, testCaseId));
  const incidents = new Map<number, ReportIncident>();
  for (const list of found) for (const incident of list) incidents.set(incident.incidentId, incident);
  return ok({
    links: Object.fromEntries(ids.map((testCaseId, i) => [testCaseId, found[i].map((incident) => incident.incidentId)])),
    incidents: [...incidents.values()],
  });
});
