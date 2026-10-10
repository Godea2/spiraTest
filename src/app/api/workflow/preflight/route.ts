import { handler, ok, parseBody } from "@/lib/server/http";
import { readOverrides } from "@/lib/server/overrides-cookie";
import { preflightRequestSchema } from "@/lib/server/schemas";
import { runPreflight } from "@/lib/server/workflow";

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, preflightRequestSchema);
  return ok(await runPreflight(input, await readOverrides()));
});
