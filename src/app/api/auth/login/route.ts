import { z } from "zod";
import { cookies, headers } from "next/headers";
import { logActivity } from "@/lib/server/activity-store";
import {
  clearFailedLogins,
  loginRateLimited,
  passwordMatches,
  recordFailedLogin,
} from "@/lib/server/auth";
import { handler, jsonError, ok, parseBody } from "@/lib/server/http";
import {
  authConfigured,
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/server/session";

const schema = z.object({ password: z.string().min(1, "Enter the password.").max(512) });

export const POST = handler(
  async (request: Request) => {
    if (!authConfigured()) {
      return jsonError(
        503,
        "Sign-in is not configured. Set APP_PASSWORD and SESSION_SECRET (16+ characters) on the server.",
      );
    }
    const headerList = await headers();
    const clientKey =
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || headerList.get("x-real-ip") || "local";
    if (loginRateLimited(clientKey)) {
      return jsonError(429, "Too many attempts. Wait 15 minutes and try again.");
    }
    const { password } = await parseBody(request, schema);
    if (!passwordMatches(password)) {
      recordFailedLogin(clientKey);
      return jsonError(401, "That password is not correct.");
    }
    clearFailedLogins(clientKey);
    const store = await cookies();
    store.set(SESSION_COOKIE, await createSessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    await logActivity({ type: "auth.signIn", message: "Signed in." });
    return ok({ ok: true });
  },
  { public: true },
);
