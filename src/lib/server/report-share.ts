import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { defaultReportOptions, reportOptionsSchema, type ReportOptions } from "@/lib/domain/report";
import { PLATFORMS, type TestSetMapping } from "@/lib/domain/types";
import { readItems, storeConfigured, writeItems } from "@/lib/server/store";

/**
 * Public report links. New links use a short code (`/r/xY7k2m9pQz`) stored in Supabase that points at a
 * signed token. Older long tokens still work. The signed payload holds the report's setup and expiry so
 * the link can only open that one report. Changing SESSION_SECRET revokes every signed token.
 */

export const SHARE_DAYS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN = 12_000;
const MAX_JSON = 200_000;
/** Short public codes: URL-safe, no ambiguous 0/O/1/l. */
const SHORT_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SHORT_LEN = 10;
const SHORT_KEY = (code: string) => `report-share:${code}`;

const storedShareSchema = z.object({
  v: z.literal(1),
  token: z.string().min(20).max(MAX_TOKEN),
  expiresAt: z.string().datetime(),
});

export const shareMappingSchema = z.object({
  id: z.string().max(100),
  testSetId: z.number().int().positive(),
  testSetName: z.string().max(300),
  platform: z.enum(PLATFORMS),
  module: z.string().max(200),
});

const payloadSchema = z.object({
  v: z.literal(1),
  p: z.number().int().positive(),
  o: reportOptionsSchema,
  m: z.array(shareMappingSchema).max(1000),
  e: z.number().int().positive(),
});

export class ShareError extends Error {}

function shareKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) return null;
  return createHmac("sha256", secret).update("spira-reconciler/report-share/v1").digest();
}

const signature = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

export function createShareToken(input: {
  projectId: number;
  options: ReportOptions;
  mappings: TestSetMapping[];
  days: number;
  now?: number;
}): { token: string; expiresAt: string } {
  const key = shareKey();
  if (!key) throw new ShareError("SESSION_SECRET is not configured on the server.");
  const expires = (input.now ?? Date.now()) + input.days * DAY_MS;
  const payload = payloadSchema.parse({ v: 1, p: input.projectId, o: input.options, m: input.mappings, e: Math.floor(expires / 1000) });
  const body = deflateRawSync(JSON.stringify(payload)).toString("base64url");
  const token = `${body}.${signature(key, body)}`;
  if (token.length > MAX_TOKEN) throw new ShareError("This report's setup is too large to share as a link. Shorten the notes and try again.");
  return { token, expiresAt: new Date(payload.e * 1000).toISOString() };
}

/** True when the path segment is a short code, not a legacy signed token. */
export function isShortShareCode(id: string): boolean {
  return id.length >= 6 && id.length <= 32 && !id.includes(".") && /^[A-Za-z0-9_-]+$/.test(id);
}

function shortCode(length = SHORT_LEN): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length];
  return out;
}

async function allocateShareCode(): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = shortCode();
    const existing = await readItems([SHORT_KEY(code)]);
    const row = existing[0];
    if (!row || row.deleted || row.value == null) return code;
  }
  throw new ShareError("Could not allocate a short link. Try again.");
}

/**
 * Creates a public link. Prefers a short `/r/{code}` stored in Supabase; falls back to the long signed
 * token when shared storage is not configured.
 */
export async function createPublicShare(input: {
  projectId: number;
  options: ReportOptions;
  mappings: TestSetMapping[];
  days: number;
  now?: number;
}): Promise<{ path: string; expiresAt: string }> {
  const { token, expiresAt } = createShareToken(input);
  if (!storeConfigured()) {
    return { path: `/r/${token}`, expiresAt };
  }
  try {
    const code = await allocateShareCode();
    await writeItems([{ key: SHORT_KEY(code), value: { v: 1, token, expiresAt } }]);
    return { path: `/r/${code}`, expiresAt };
  } catch (error) {
    console.error("Short report link could not be stored; using the long token.", error);
    return { path: `/r/${token}`, expiresAt };
  }
}

export type ShareRead =
  | { ok: true; projectId: number; options: ReportOptions; mappings: TestSetMapping[]; expiresAt: string }
  | { ok: false; reason: "invalid" | "expired" };

export function readShareToken(token: string, now = Date.now()): ShareRead {
  const key = shareKey();
  const dot = token.lastIndexOf(".");
  if (!key || token.length > MAX_TOKEN || dot <= 0) return { ok: false, reason: "invalid" };
  const body = token.slice(0, dot);
  const expected = Buffer.from(signature(key, body));
  const actual = Buffer.from(token.slice(dot + 1));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "invalid" };
  let parsed: z.infer<typeof payloadSchema>;
  try {
    const json = inflateRawSync(Buffer.from(body, "base64url"), { maxOutputLength: MAX_JSON }).toString("utf8");
    const result = payloadSchema.safeParse(JSON.parse(json));
    if (!result.success) return { ok: false, reason: "invalid" };
    parsed = result.data;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.e * 1000 <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    projectId: parsed.p,
    options: { ...defaultReportOptions(), ...parsed.o },
    mappings: parsed.m,
    expiresAt: new Date(parsed.e * 1000).toISOString(),
  };
}

/** Resolves a short code or a legacy long token into the report setup. */
export async function resolveShare(id: string, now = Date.now()): Promise<ShareRead> {
  const decoded = decodeURIComponent(id);
  if (isShortShareCode(decoded)) {
    if (!storeConfigured()) return { ok: false, reason: "invalid" };
    try {
      const items = await readItems([SHORT_KEY(decoded)]);
      const row = items[0];
      if (!row || row.deleted || row.value == null) return { ok: false, reason: "invalid" };
      const stored = storedShareSchema.safeParse(row.value);
      if (!stored.success) return { ok: false, reason: "invalid" };
      if (Date.parse(stored.data.expiresAt) <= now) return { ok: false, reason: "expired" };
      return readShareToken(stored.data.token, now);
    } catch (error) {
      console.error("Short report link could not be read", error);
      return { ok: false, reason: "invalid" };
    }
  }
  return readShareToken(decoded, now);
}
