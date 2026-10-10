import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/server/http";
import { compareTestSet } from "@/lib/server/reconciler";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ testSetId: z.number().int().positive() });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const { testSetId } = await parseBody(request, schema);
  return ok({ draft: await compareTestSet(id, testSetId) });
});
