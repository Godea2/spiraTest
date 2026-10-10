import { handler, ok, parseBody } from "@/lib/server/http";
import { undoSignOffRequestSchema } from "@/lib/server/schemas";
import { undoSignOff } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, undoSignOffRequestSchema);
  return ok(await undoSignOff(input));
});
