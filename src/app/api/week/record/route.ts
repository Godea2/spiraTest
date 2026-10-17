import { handler, ok, parseBody } from "@/lib/server/http";
import { weekRecordRequestSchema } from "@/lib/server/schemas";
import { recordWeekRuns } from "@/lib/server/week";

export const maxDuration = 300;

/** Records Pass / Fail / Blocked runs from a weekly sheet against the sealed week catalog. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, weekRecordRequestSchema);
  return ok(await recordWeekRuns(input));
});
