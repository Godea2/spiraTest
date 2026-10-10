import { logActivity } from "@/lib/server/activity-store";
import { duplicateDraft } from "@/lib/server/draft-store";
import { handler, ok } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const draft = await duplicateDraft(id);
  await logActivity({
    type: "draft.duplicated",
    message: `Duplicated draft as "${draft.name}".`,
    draftId: draft.id,
    module: draft.module,
    details: { sourceDraftId: id },
  });
  return ok({ draft }, 201);
});
