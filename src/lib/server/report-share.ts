import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { defaultReportOptions, reportOptionsSchema, type ReportOptions } from "@/lib/domain/report";
import { PLATFORMS, type TestSetMapping } from "@/lib/domain/types";
import { readItems, storeConfigured, writeItems } from "@/lib/server/store";

/**
 * Public report links. New links are short and dated (`/r/2026-10-17-k3m2`), with the report setup
 * stored in Supabase. Older long signed tokens still open. Changing SESSION_SECRET revokes signed tokens.
 */

export const SHARE_DAYS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN = 12_000;
const MAX_JSON = 200_000;
/** Short public suffix: URL-safe, no ambiguous 0/O/1/l. */
const SHORT_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SHORT_KEY = (code: string) => `report-share:${code}`;

const storedShareSchema = z.object({
  v: z.literal(1),
  token: z.string().min(20).max(MAX_TOKEN),
  expiresAt: z.string().min(10),
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
  if (id.includes(".")) return false;
  // Dated links: /r/2026-10-17-k3m2
  if (/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9]{4,8}$/.test(id)) return true;
  // Earlier random short codes (no date prefix)
  return id.length >= 6 && id.length <= 32 && /^[A-Za-z0-9_-]+$/.test(id);
}

function randomSuffix(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length];
  return out;
}

/** Readable share path segment: report date + short suffix. */
export function formatShareCode(now = Date.now(), suffix = randomSuffix(4)): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${day}-${suffix}`;
}

async function allocateShareCode(now: number): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = formatShareCode(now);
    const existing = await readItems([SHORT_KEY(code)]);
    const row = existing[0];
    if (!row || row.deleted || row.value == null) return code;
  }
  throw new ShareError("Could not allocate a short link. Try again.");
}

/**
 * Creates a short dated public link (`/r/2026-10-17-k3m2`). Requires Supabase shared storage — never
 * returns the long signed token in the URL.
 */
export async function createPublicShare(input: {
  projectId: number;
  options: ReportOptions;
  mappings: TestSetMapping[];
  days: number;
  now?: number;
}): Promise<{ path: string; expiresAt: string }> {
  if (!storeConfigured()) {
    throw new ShareError(
      "Short report links need Supabase. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server, then try again.",
    );
  }
  const now = input.now ?? Date.now();
  const { token, expiresAt } = createShareToken({ ...input, now });
  try {
    const code = await allocateShareCode(now);
    await writeItems([{ key: SHORT_KEY(code), value: { v: 1, token, expiresAt } }]);
    return { path: `/r/${code}`, expiresAt };
  } catch (error) {
    if (error instanceof ShareError) throw error;
    console.error("Short report link could not be stored", error);
    throw new ShareError("Could not save the short link in shared storage. Check Supabase, then try again.");
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

/** Resolves a short dated code or a legacy long token into the report setup. */
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
