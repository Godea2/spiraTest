import { z } from "zod";
import { reportOptionsSchema } from "@/lib/domain/report";
import { handler, HttpError, ok, parseBody } from "@/lib/server/http";
import { createShareToken, SHARE_DAYS, shareMappingSchema, ShareError } from "@/lib/server/report-share";

const shareRequestSchema = z.object({
  projectId: z.number().int().positive(),
  options: reportOptionsSchema,
  mappings: z.array(shareMappingSchema).max(1000),
  days: z.union(SHARE_DAYS.map((d) => z.literal(d))),
});

/** Signs a public, read-only link to one report. Only a signed-in user can create one. */
export const POST = handler(async (request: Request) => {
  const { projectId, options, mappings, days } = await parseBody(request, shareRequestSchema);
  try {
    const { token, expiresAt } = createShareToken({ projectId, options, mappings, days });
    return ok({ path: `/r/${token}`, expiresAt });
  } catch (error) {
    if (error instanceof ShareError) throw new HttpError(400, error.message);
    throw error;
  }
});
