import { handler, ok, parseBody } from "@/lib/server/http";
import { testSetStatusRequestSchema } from "@/lib/server/schemas";
import { settleTestSetStatus } from "@/lib/server/workflow";

export const maxDuration = 30;

/** Sets a test set's status in Spira to the one its cases call for (In Progress or Completed). */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, testSetStatusRequestSchema);
  return ok(await settleTestSetStatus(input));
});
