import { parseTesterNotes } from "@/lib/server/gemini";
import { handler, ok, parseBody } from "@/lib/server/http";
import { notesParseRequestSchema } from "@/lib/server/schemas";

export const maxDuration = 60;

/** Splits informal tester notes into done / left bullets. Read-only. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, notesParseRequestSchema);
  return ok(await parseTesterNotes(input.notes, input.modules));
});
