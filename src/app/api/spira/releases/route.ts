import { handler, ok, parseBody } from "@/lib/server/http";
import { releaseListSchema } from "@/lib/server/schemas";
import { listReleases } from "@/lib/server/spira";

/** Read-only: releases and their sprints in the project, for the release picker. */
export const POST = handler(async (request: Request) => {
  const { projectId } = await parseBody(request, releaseListSchema);
  return ok({ releases: await listReleases(projectId) });
});
