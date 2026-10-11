import { understandDefect } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { defectUnderstandRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Works out which feature a defect is in and the other names it goes by. Changes nothing. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectUnderstandRequestSchema);
  return ok(await understandDefect(input.description, input.modules));
});
