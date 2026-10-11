import { shortlistDefectCases } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { defectSearchRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Reads a defect description and picks, from case names, the cases it may make fail. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectSearchRequestSchema);
  return ok(await shortlistDefectCases(input.description, input.cases, input.broad ?? false));
});
