import { logActivity } from "@/lib/server/activity-store";
import { handler, jsonError, ok } from "@/lib/server/http";
import { resetMockState } from "@/lib/server/mock";
import { getSettings } from "@/lib/server/settings-store";

export const POST = handler(async () => {
  const settings = await getSettings();
  if (!settings.mockMode) return jsonError(400, "Mock data can only be reset while Mock mode is on.");
  await resetMockState();
  await logActivity({ type: "mock.reset", message: "Mock Spira data reset to its original fixture." });
  return ok({ ok: true });
});
