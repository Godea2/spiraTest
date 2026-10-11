import { verifyDefectCases } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { defectVerifyRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Checks each case's steps against a defect: whether, and at which step, it fails. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectVerifyRequestSchema);
  return ok({ matches: await verifyDefectCases(input.description, input.analysis, input.cases) });
});
