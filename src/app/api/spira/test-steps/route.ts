import { handler, ok, parseBody } from "@/lib/server/http";
import { testStepsRequestSchema } from "@/lib/server/schemas";
import { readStepText } from "@/lib/server/workflow";

export const maxDuration = 60;

/** Read-only: the text of each test case's steps, for keyword matching. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, testStepsRequestSchema);
  return ok(await readStepText(input));
});
