import { z } from "zod";
import { isSyncedKey } from "@/lib/domain/store-sync";
import { handler, ok, parseBody } from "@/lib/server/http";
import { listEntries, storeConfigured, writeItems } from "@/lib/server/store";

const keySchema = z.string().refine(isSyncedKey, "Not a shared storage key.");

const writeSchema = z.object({
  items: z.array(z.object({ key: keySchema, value: z.unknown() })).min(1).max(100),
});

/** Whether shared storage is set up, and every stored key with when it changed. */
export const GET = handler(async () => {
  if (!storeConfigured()) return ok({ configured: false });
  return ok({ configured: true, entries: await listEntries() });
});

/** Saves items from the browser; a null value deletes. */
export const PUT = handler(async (request: Request) => {
  const { items } = await parseBody(request, writeSchema);
  return ok({ items: await writeItems(items.map(({ key, value }) => ({ key, value: value ?? null }))) });
});
