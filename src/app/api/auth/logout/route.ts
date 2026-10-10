import { cookies } from "next/headers";
import { handler, ok } from "@/lib/server/http";
import { SESSION_COOKIE } from "@/lib/server/session";

export const POST = handler(
  async () => {
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return ok({ ok: true });
  },
  { public: true },
);
