import { handler, ok, parseBody } from "@/lib/server/http";
import { applyBatch } from "@/lib/server/reconciler";
import { applyBatchSchema } from "@/lib/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const input = await parseBody(request, applyBatchSchema);
  return ok(await applyBatch(id, input));
});
