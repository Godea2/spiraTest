import { handler, ok } from "@/lib/server/http";
import { restoreSoftDeleted, storeConfigured } from "@/lib/server/store";

/** Undelete soft-deleted drafts / sync keys so browsers can pull them back. */
export const POST = handler(async () => {
  if (!storeConfigured()) {
    return ok({ restored: false, reason: "Shared storage is not set up on the server." });
  }
  const result = await restoreSoftDeleted();
  return ok({ restored: true, ...result });
});
