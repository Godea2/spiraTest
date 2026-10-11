import { handler, ok, parseBody } from "@/lib/server/http";
import { testCaseLookupSchema } from "@/lib/server/schemas";
import { getTestCaseDetail } from "@/lib/server/spira";

/** Read-only: a test case with its steps and test data, for the card details on the board. */
export const POST = handler(async (request: Request) => {
  const { projectId, testCaseId } = await parseBody(request, testCaseLookupSchema);
  return ok(await getTestCaseDetail(projectId, testCaseId));
});
