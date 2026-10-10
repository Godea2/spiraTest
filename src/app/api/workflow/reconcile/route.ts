import { handler, ok, parseBody } from "@/lib/server/http";
import { readOverrides } from "@/lib/server/overrides-cookie";
import { reconcileSchema } from "@/lib/server/schemas";
import { reconcileTestSet } from "@/lib/server/workflow";

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, reconcileSchema);
  return ok(await reconcileTestSet(input, await readOverrides()));
});
