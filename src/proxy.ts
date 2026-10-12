import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/server/session";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/healthz"]);
/** Shared reports: the page checks the link's signature and shows that one report, read-only. */
const PUBLIC_PREFIX = "/r/";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  if (isApi && MUTATING.has(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== request.nextUrl.origin) {
      const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
      if (!forwardedHost || new URL(origin).host !== forwardedHost) {
        return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
      }
    }
  }

  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith(PUBLIC_PREFIX)) return NextResponse.next();

  const authenticated = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (authenticated) return NextResponse.next();

  if (isApi) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)"],
};
