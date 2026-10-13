import { handler, ok, parseBody } from "@/lib/server/http";
import { defectFileUndoRequestSchema } from "@/lib/server/schemas";
import { deleteDefectFile } from "@/lib/server/workflow";

export const maxDuration = 30;

/** Deletes a file this app attached for a defect. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectFileUndoRequestSchema);
  return ok(await deleteDefectFile(input));
});
