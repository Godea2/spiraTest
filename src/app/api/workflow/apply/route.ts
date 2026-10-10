import { handler, ok, parseBody } from "@/lib/server/http";
import { readOverrides } from "@/lib/server/overrides-cookie";
import { applyRequestSchema } from "@/lib/server/schemas";
import { applyBatch } from "@/lib/server/workflow";

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, applyRequestSchema);
  return ok(await applyBatch(input, await readOverrides()));
});
