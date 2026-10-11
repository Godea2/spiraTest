import { shortlistDefectCases } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { defectSearchRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Picks, from case names, the cases a defect is about, matched to the feature it is in. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectSearchRequestSchema);
  return ok({ candidates: await shortlistDefectCases(input.description, input.analysis, input.cases) });
});
