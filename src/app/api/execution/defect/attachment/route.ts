import { handler, ok, parseBody } from "@/lib/server/http";
import { defectFileRequestSchema } from "@/lib/server/schemas";
import { attachDefectFile } from "@/lib/server/workflow";

export const maxDuration = 60;

/** Uploads one screenshot or file for a defect, attached to its failed runs and its incident. */
export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, defectFileRequestSchema);
  return ok(await attachDefectFile(input));
});
