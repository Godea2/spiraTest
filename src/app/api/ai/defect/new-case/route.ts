import { draftDefectCase } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { defectNewCaseRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Drafts a test case for a defect no existing case covers, and the test sets it belongs in. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectNewCaseRequestSchema);
  return ok(await draftDefectCase(input.description, input.analysis, input.testSets));
});
