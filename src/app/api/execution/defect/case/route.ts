import { handler, ok, parseBody } from "@/lib/server/http";
import { defectCaseCreateRequestSchema } from "@/lib/server/schemas";
import { createDefectCase } from "@/lib/server/workflow";

export const maxDuration = 60;

/** Creates a test case for a defect and adds it to the chosen test sets. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectCaseCreateRequestSchema);
  return ok(await createDefectCase(input));
});
