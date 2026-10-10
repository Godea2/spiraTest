import { logActivity } from "@/lib/server/activity-store";
import { handler, ok, parseBody } from "@/lib/server/http";
import {
  getSettings,
  settingsUpdateSchema,
  toPublicSettings,
  updateSettings,
} from "@/lib/server/settings-store";

export const GET = handler(async () => ok(toPublicSettings(await getSettings())));

export const PUT = handler(async (request: Request) => {
  const update = await parseBody(request, settingsUpdateSchema);
  const before = await getSettings();
  const saved = await updateSettings(update);

  const endpointNotes: string[] = [];
  for (const [kind, field] of [["reconcile", "reconcileUrl"], ["apply", "applyUrl"]] as const) {
    if (before.endpoints[field] !== saved.endpoints[field]) {
      endpointNotes.push(saved.endpoints[field] ? `${kind} URL replaced` : `${kind} override cleared`);
    }
  }
  await logActivity({
    type: "settings.updated",
    message: `Settings saved${endpointNotes.length ? ` (${endpointNotes.join(", ")})` : ""}.`,
    details: {
      mockMode: saved.mockMode,
      projectId: saved.projectId,
      releaseId: saved.releaseId,
      mappings: saved.mappings.length,
    },
  });
  return ok(toPublicSettings(saved));
});
