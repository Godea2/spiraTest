import { reviewBlockedCases } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { blockedReviewRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Asks Gemini whether cases whose scenario mentions a not-implemented keyword really depend on it. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, blockedReviewRequestSchema);
  return ok({ verdicts: await reviewBlockedCases(input.module, input.cases) });
});
