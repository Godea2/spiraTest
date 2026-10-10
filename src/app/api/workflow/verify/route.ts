import { handler, ok, parseBody } from "@/lib/server/http";
import { verifyRequestSchema } from "@/lib/server/schemas";
import { verifyApply } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, verifyRequestSchema);
  return ok(await verifyApply(input));
});
