import { aiStatus } from "@/lib/server/gemini";
import { handler, ok } from "@/lib/server/http";

/** Whether the AI review is configured, and which model it uses. Never returns the key. */
export const GET = handler(async () => ok(aiStatus()));
