import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { defaultReportOptions, reportOptionsSchema, type ReportOptions } from "@/lib/domain/report";
import { PLATFORMS, type TestSetMapping } from "@/lib/domain/types";

/**
 * Public report links. The token holds the report's setup, signed by the server and with an expiry, so
 * whoever holds the link can read that one report and nothing else: it cannot be edited into another
 * report, and it opens no part of the app. Changing SESSION_SECRET revokes every link.
 */

export const SHARE_DAYS = [7, 30, 90] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN = 12_000;
const MAX_JSON = 200_000;

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
