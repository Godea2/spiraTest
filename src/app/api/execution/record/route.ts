import { handler, ok, parseBody } from "@/lib/server/http";
import { executionRecordRequestSchema } from "@/lib/server/schemas";
import { recordExecutions } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, executionRecordRequestSchema);
  return ok(await recordExecutions(input));
});
