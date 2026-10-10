import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export function passwordMatches(candidate: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return false;
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginRateLimited(clientKey: string, now = Date.now()): boolean {
  const entry = attempts.get(clientKey);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedLogin(clientKey: string, now = Date.now()): void {
  const entry = attempts.get(clientKey);
  if (!entry || entry.resetAt < now) attempts.set(clientKey, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearFailedLogins(clientKey: string): void {
  attempts.delete(clientKey);
}

export async function hasSession(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}
