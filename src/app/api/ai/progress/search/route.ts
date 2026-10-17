import { shortlistProgressCases } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { progressSearchRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Picks, from case names, the cases that cover the work described. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, progressSearchRequestSchema);
  return ok({ candidates: await shortlistProgressCases(input.description, input.analysis, input.cases) });
});
