import { handler, ok, parseBody } from "@/lib/server/http";
import { executionStatusRequestSchema } from "@/lib/server/schemas";
import { readExecutionStatus } from "@/lib/server/workflow";

export const maxDuration = 60;

/** Read-only: the latest execution status of every case in the draft's test sets. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, executionStatusRequestSchema);
  return ok(await readExecutionStatus(input));
});
