import { handler, ok, parseBody } from "@/lib/server/http";
import { defectLogRequestSchema } from "@/lib/server/schemas";
import { logDefect } from "@/lib/server/workflow";

export const maxDuration = 60;

/** Logs one defect as a Spira incident linked to the failed step of each run. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectLogRequestSchema);
  return ok(await logDefect(input));
});
