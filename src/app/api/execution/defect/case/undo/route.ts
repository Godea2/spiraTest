import { handler, ok, parseBody } from "@/lib/server/http";
import { defectCaseUndoRequestSchema } from "@/lib/server/schemas";
import { deleteDefectCase } from "@/lib/server/workflow";

export const maxDuration = 30;

/** Deletes a test case this app created for a defect. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectCaseUndoRequestSchema);
  return ok(await deleteDefectCase(input));
});
