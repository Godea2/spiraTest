import { handler, ok, parseBody } from "@/lib/server/http";
import { reconcileSchema } from "@/lib/server/schemas";
import { reconcileTestSet } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, reconcileSchema);
  return ok(await reconcileTestSet(input));
});
