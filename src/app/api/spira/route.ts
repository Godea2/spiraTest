import { handler, ok } from "@/lib/server/http";
import { checkConnection, spiraStatus } from "@/lib/server/spira";

/** Configuration summary only; makes no call to Spira. */
export const GET = handler(async () => ok(spiraStatus()));

/** Read-only connection test: the signed-in Spira user and the projects they can open. */
export const POST = handler(async () => ok(await checkConnection()));
