import { handler, ok, parseBody } from "@/lib/server/http";
import { applyRequestSchema } from "@/lib/server/schemas";
import { applyBatch } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, applyRequestSchema);
  return ok(await applyBatch(input));
});
