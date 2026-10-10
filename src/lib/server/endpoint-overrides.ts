import "server-only";
import { createHash } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import type { EndpointKind, EndpointsStatus } from "@/lib/domain/types";
import { endpointStatus, validateWebhookUrl, webhookSecret } from "./endpoints";

/**
 * Saved webhook URL overrides live in an encrypted, httpOnly cookie: the server has no
 * storage of its own, and the URLs (which can carry webhook tokens) must never be
 * readable by the browser.
 */
export const OVERRIDES_COOKIE = "srs_endpoints";
export const OVERRIDES_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export interface EndpointOverrides {
  reconcileUrl: string | null;
  applyUrl: string | null;
}

export const NO_OVERRIDES: EndpointOverrides = { reconcileUrl: null, applyUrl: null };

function overridesKey(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) return null;
  return new Uint8Array(createHash("sha256").update(`spira-reconciler/endpoints/v1:${secret}`).digest());
}

export async function encryptOverrides(overrides: EndpointOverrides): Promise<string> {
  const key = overridesKey();
  if (!key) throw new Error("SESSION_SECRET is not configured.");
  return new EncryptJWT({ r: overrides.reconcileUrl, a: overrides.applyUrl })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${OVERRIDES_MAX_AGE_SECONDS}s`)
    .encrypt(key);
}

/** Anything unreadable (wrong secret, expired, tampered) is treated as no overrides. */
export async function decryptOverrides(token: string | undefined | null): Promise<EndpointOverrides> {
  const key = overridesKey();
  if (!key || !token) return NO_OVERRIDES;
  try {
    const { payload } = await jwtDecrypt(token, key);
    const pick = (value: unknown) => (typeof value === "string" && validateWebhookUrl(value).ok ? value : null);
    return { reconcileUrl: pick(payload.r), applyUrl: pick(payload.a) };
  } catch {
    return NO_OVERRIDES;
  }
}

export function toEndpointsStatus(overrides: EndpointOverrides): EndpointsStatus {
  return {
    endpoints: {
      reconcile: endpointStatus("reconcile", overrides.reconcileUrl),
      apply: endpointStatus("apply", overrides.applyUrl),
    },
    webhookSecretConfigured: webhookSecret() !== null,
  };
}

export type EndpointChange = { url?: string; clear?: boolean } | undefined;

export class EndpointValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super("Some fields are not valid.");
  }
}

/** Blank keeps the current value, `clear` removes it, anything else must be a valid webhook URL. */
export function applyEndpointChanges(
  current: EndpointOverrides,
  changes: Partial<Record<EndpointKind, EndpointChange>>,
): EndpointOverrides {
  const errors: Record<string, string> = {};
  const next = (kind: EndpointKind, value: string | null): string | null => {
    const change = changes[kind];
    if (!change) return value;
    if (change.clear) return null;
    const url = change.url?.trim();
    if (!url) return value;
    const check = validateWebhookUrl(url);
    if (!check.ok) {
      errors[`endpoints.${kind}`] = check.error;
      return value;
    }
    return check.url.toString();
  };
  const result = {
    reconcileUrl: next("reconcile", current.reconcileUrl),
    applyUrl: next("apply", current.applyUrl),
  };
  if (Object.keys(errors).length > 0) throw new EndpointValidationError(errors);
  return result;
}
