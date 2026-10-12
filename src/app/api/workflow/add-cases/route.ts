import { handler, ok, parseBody } from "@/lib/server/http";
import { mirrorAddRequestSchema } from "@/lib/server/schemas";
import { addCasesFromSource } from "@/lib/server/workflow";

export const maxDuration = 60;

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, mirrorAddRequestSchema);
  return ok(await addCasesFromSource(input));
});
