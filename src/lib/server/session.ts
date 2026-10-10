import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "srs_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MIN_SECRET_LENGTH = 16;

function secretKey(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return new TextEncoder().encode(secret);
}

export function authConfigured(): boolean {
  return secretKey() !== null && Boolean(process.env.APP_PASSWORD);
}

export async function createSessionToken(): Promise<string> {
  const key = secretKey();
  if (!key) throw new Error("SESSION_SECRET is not configured.");
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("admin")
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  const key = secretKey();
  if (!key || !token) return false;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload.sub === "admin";
  } catch {
    return false;
  }
}
