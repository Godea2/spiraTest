import { understandProgress } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { progressUnderstandRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Works out which feature the tester covered and the other names it goes by. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, progressUnderstandRequestSchema);
  return ok(await understandProgress(input.description, input.modules));
});
