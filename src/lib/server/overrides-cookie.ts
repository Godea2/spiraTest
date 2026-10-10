import "server-only";
import { cookies } from "next/headers";
import {
  decryptOverrides,
  encryptOverrides,
  OVERRIDES_COOKIE,
  OVERRIDES_MAX_AGE_SECONDS,
  type EndpointOverrides,
} from "./endpoint-overrides";

export async function readOverrides(): Promise<EndpointOverrides> {
  return decryptOverrides((await cookies()).get(OVERRIDES_COOKIE)?.value);
}

export async function writeOverrides(overrides: EndpointOverrides): Promise<void> {
  const store = await cookies();
  if (!overrides.reconcileUrl && !overrides.applyUrl) {
    store.delete(OVERRIDES_COOKIE);
    return;
  }
  store.set(OVERRIDES_COOKIE, await encryptOverrides(overrides), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api",
    maxAge: OVERRIDES_MAX_AGE_SECONDS,
  });
}
