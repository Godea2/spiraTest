import { logActivity } from "@/lib/server/activity-store";
import { createDraft, listDrafts } from "@/lib/server/draft-store";
import { handler, HttpError, ok, parseBody } from "@/lib/server/http";
import { createDraftSchema } from "@/lib/server/schemas";
import { getSettings, mappingsForModule } from "@/lib/server/settings-store";

export const GET = handler(async () => ok({ drafts: await listDrafts() }));

export const POST = handler(async (request: Request) => {
  const input = await parseBody(request, createDraftSchema);
  const settings = await getSettings();
  const mapped = new Set(mappingsForModule(settings, input.module).map((m) => m.testSetId));
  if (mapped.size === 0) throw new HttpError(400, `${input.module} has no test sets in Settings.`);
  const unknown = input.testSetIds.filter((id) => !mapped.has(id));
  if (unknown.length) {
    throw new HttpError(400, `Test set(s) ${unknown.join(", ")} are not mapped to ${input.module}.`);
  }
  const draft = await createDraft({
    name: input.name,
    module: input.module,
    projectId: settings.projectId,
    releaseId: settings.releaseId,
    releaseLabel: settings.releaseLabel,
    source: input.source,
    rows: input.rows,
    testSetIds: [...new Set(input.testSetIds)],
  });
  await logActivity({
    type: "draft.created",
    message: `Created draft "${draft.name}" with ${draft.rows.length} workbook rows.`,
    draftId: draft.id,
    module: draft.module,
    details: { testSetIds: draft.testSetIds, mock: settings.mockMode },
  });
  return ok({ draft }, 201);
});
