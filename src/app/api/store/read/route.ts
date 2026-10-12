import { z } from "zod";
import { isSyncedKey } from "@/lib/domain/store-sync";
import { handler, ok, parseBody } from "@/lib/server/http";
import { readItems } from "@/lib/server/store";

const readSchema = z.object({
  keys: z.array(z.string().refine(isSyncedKey, "Not a shared storage key.")).min(1).max(100),
});

/** The stored values of some keys. */
export const POST = handler(async (request: Request) => {
  const { keys } = await parseBody(request, readSchema);
  return ok({ items: await readItems(keys) });
});
