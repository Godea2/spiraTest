import { handler, ok, parseBody } from "@/lib/server/http";
import { preflightRequestSchema } from "@/lib/server/schemas";
import { runPreflight } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, preflightRequestSchema);
  return ok(await runPreflight(input));
});
