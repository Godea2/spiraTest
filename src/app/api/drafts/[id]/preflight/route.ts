import { handler, ok } from "@/lib/server/http";
import { runPreflight } from "@/lib/server/reconciler";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return ok(await runPreflight(id));
});
