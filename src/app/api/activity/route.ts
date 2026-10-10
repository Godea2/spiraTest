import { listActivity } from "@/lib/server/activity-store";
import { handler, ok } from "@/lib/server/http";

export const GET = handler(async () => ok({ entries: await listActivity() }));
