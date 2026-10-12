import type { RunDetail } from "@/lib/domain/types";
import { handler, ok, parseBody } from "@/lib/server/http";
import { runDetailRequestSchema } from "@/lib/server/schemas";
import { getRunDetail, SpiraError } from "@/lib/server/spira";
import { inPool } from "@/lib/server/workflow";

export const maxDuration = 60;

const READ_CONCURRENCY = 5;

/** Read-only: recorded runs step by step. A run that cannot be read is reported and left out. */
export const POST = handler(async (request: Request) => {
  const { projectId, testRunIds } = await parseBody(request, runDetailRequestSchema);
  const reads = await inPool([...new Set(testRunIds)], READ_CONCURRENCY, async (testRunId) => {
    try {
      return { run: await getRunDetail(projectId, testRunId), error: null };
    } catch (error) {
      if (!(error instanceof SpiraError)) throw error;
      return { run: null, error: { testRunId, message: error.message } };
    }
  });
  return ok({
    runs: reads.flatMap((r) => (r.run ? [r.run] : [])) satisfies RunDetail[],
    errors: reads.flatMap((r) => (r.error ? [r.error] : [])),
  });
});
