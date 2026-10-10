import { handler, ok, parseBody } from "@/lib/server/http";
import { connectionCheckSchema } from "@/lib/server/schemas";
import { checkConnection, spiraStatus } from "@/lib/server/spira";

/** Configuration summary only; makes no call to Spira. */
export const GET = handler(async () => ok(spiraStatus()));

/** Read-only connection test: signed-in user and project name. */
export const POST = handler(async (request: Request) => {
  const { projectId } = await parseBody(request, connectionCheckSchema);
  return ok(await checkConnection(projectId));
});
