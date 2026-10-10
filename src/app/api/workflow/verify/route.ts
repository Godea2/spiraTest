import { handler, ok, parseBody } from "@/lib/server/http";
import { readOverrides } from "@/lib/server/overrides-cookie";
import { verifyRequestSchema } from "@/lib/server/schemas";
import { verifyApply } from "@/lib/server/workflow";

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, verifyRequestSchema);
  return ok(await verifyApply(input, await readOverrides()));
});
