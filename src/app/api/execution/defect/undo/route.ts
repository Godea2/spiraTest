import { handler, ok, parseBody } from "@/lib/server/http";
import { defectUndoRequestSchema } from "@/lib/server/schemas";
import { undoDefect } from "@/lib/server/workflow";

export const maxDuration = 30;

/** Deletes an incident this app logged. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectUndoRequestSchema);
  return ok(await undoDefect(input));
});
