import "server-only";
import type { StoreEntry, StoreItem, StoreWritten } from "@/lib/domain/store-sync";
import { toPayload } from "./store-rows";

/**
 * Shared storage in Supabase (tables and functions in supabase/schema.sql), reached through its REST API
 * with the secret key. Only the server holds the key; the browser goes through /api/store behind sign-in.
 */

export const STORE_ENV = { url: "SUPABASE_URL", key: "SUPABASE_SERVICE_ROLE_KEY", altKey: "SUPABASE_SECRET_KEY" } as const;
const PAGE = 1_000;
const TIMEOUT_MS = 20_000;

export class StoreError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function config(): { url: string; key: string } | null {
  const url = process.env[STORE_ENV.url]?.trim().replace(/\/+$/, "");
  const key = (process.env[STORE_ENV.key] || process.env[STORE_ENV.altKey])?.trim();
  return url && key ? { url, key } : null;
}

export const storeConfigured = (): boolean => config() !== null;

async function rest(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<Response> {
  const c = config();
  if (!c) throw new StoreError(503, "Shared storage is not set up.");
  const headers: Record<string, string> = { apikey: c.key, Accept: "application/json" };
  // Legacy service_role keys are JWTs and also go in Authorization; the newer sb_secret_ keys must not.
  if (c.key.startsWith("eyJ")) headers.Authorization = `Bearer ${c.key}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.prefer) headers.Prefer = init.prefer;
  let response: Response;
  try {
    response = await fetch(`${c.url}/rest/v1/${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StoreError(502, "Supabase could not be reached. Try again in a moment.");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`Supabase ${init.method ?? "GET"} ${path.split("?")[0]} failed with HTTP ${response.status}`, detail.slice(0, 500));
    throw new StoreError(
      502,
      response.status === 404
        ? "The app's tables were not found in Supabase. Run supabase/schema.sql in the SQL editor."
        : response.status === 401 || response.status === 403
          ? "Supabase refused the key. Set SUPABASE_SERVICE_ROLE_KEY to the project's secret (service role) key."
          : `Supabase answered HTTP ${response.status}.`,
    );
  }
  return response;
}

type Row = { key: string; value?: unknown; updated_at: string; deleted: boolean; size?: number };

const iso = (value: string) => new Date(value).toISOString();

/** Every saved key with when it last changed; no values. */
export async function listEntries(): Promise<StoreEntry[]> {
  const entries: StoreEntry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = (await (await rest(`sync_keys?select=key,updated_at,deleted,size&order=key&limit=${PAGE}&offset=${offset}`)).json()) as Row[];
    for (const r of rows) entries.push({ key: r.key, updatedAt: iso(r.updated_at), deleted: r.deleted, size: r.size ?? 0 });
    if (rows.length < PAGE) return entries;
  }
}

/** The saved value of each key, put back together from its tables. */
export async function readItems(keys: string[]): Promise<StoreItem[]> {
  if (keys.length === 0) return [];
  const rows = (await (await rest("rpc/store_read", { method: "POST", body: { keys } })).json()) as Row[];
  return rows.map((r) => ({ key: r.key, value: r.deleted ? null : (r.value ?? null), updatedAt: iso(r.updated_at), deleted: r.deleted }));
}

/** Saves items (null deletes) in one transaction; the newest save wins, and activity entries are added to the log. */
export async function writeItems(items: Array<{ key: string; value: unknown }>, now = new Date()): Promise<StoreWritten[]> {
  if (items.length === 0) return [];
  const updatedAt = now.toISOString();
  const payload = items.map(({ key, value }) => toPayload(key, value, updatedAt));
  await rest("rpc/store_write", { method: "POST", body: { items: payload, written_at: updatedAt }, prefer: "return=minimal" });
  return payload.map((p) => ({ key: p.key, updatedAt, merged: p.kind === "activity" && !p.deleted }));
}
