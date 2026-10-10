import { allCards, normalizeDecisions } from "@/lib/domain/board";
import { logActivity } from "@/lib/server/activity-store";
import { deleteDraft, getDraft, mutateDraft } from "@/lib/server/draft-store";
import { handler, ok, parseBody } from "@/lib/server/http";
import { updateDraftSchema } from "@/lib/server/schemas";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  return ok({ draft: await getDraft(id) });
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const input = await parseBody(request, updateDraftSchema);
  let renamed: { from: string; to: string } | null = null;
  const draft = await mutateDraft(
    id,
    (d) => {
      if (input.name && input.name !== d.name) {
        renamed = { from: d.name, to: input.name };
        d.name = input.name;
      }
      if (input.decisions) {
        const next = normalizeDecisions(allCards(d.testSets), input.decisions);
        if (JSON.stringify(next) !== JSON.stringify(d.decisions)) {
          d.decisions = next;
          // Any board change invalidates the last membership check.
          d.apply.preflight = null;
        }
      }
      if (input.history) d.history = input.history;
    },
    input.expectedUpdatedAt,
  );
  if (renamed) {
    const { from, to } = renamed;
    await logActivity({ type: "draft.renamed", message: `Renamed "${from}" to "${to}".`, draftId: id, module: draft.module });
  }
  return ok({ draft });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const draft = await getDraft(id);
  await deleteDraft(id);
  await logActivity({ type: "draft.deleted", message: `Deleted draft "${draft.name}".`, draftId: id, module: draft.module });
  return ok({ ok: true });
});
