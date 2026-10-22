import { matchExistingDefects } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { defectFindExistingRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Matches a defect description to Spira incidents and app-logged defects. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectFindExistingRequestSchema);
  return ok({
    hits: await matchExistingDefects(input.description, input.analysis, input.existing),
  });
});
