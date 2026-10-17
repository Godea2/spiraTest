import { handler, ok, parseBody } from "@/lib/server/http";
import { weekCatalogRequestSchema } from "@/lib/server/schemas";
import { loadWeekCatalog } from "@/lib/server/week";

export const maxDuration = 300;

/** Read-only: sealed In Scope boards for every mobile test set on the working release. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, weekCatalogRequestSchema);
  return ok(await loadWeekCatalog(input));
});
