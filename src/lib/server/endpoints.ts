import "server-only";
import type { EndpointKind, EndpointStatus } from "@/lib/domain/types";

export const ENDPOINT_ENV: Record<EndpointKind, string> = {
  reconcile: "RECONCILE_WEBHOOK_URL",
  apply: "APPLY_WEBHOOK_URL",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type UrlCheck = { ok: true; url: URL } | { ok: false; error: string };

/** HTTPS only (plain HTTP allowed for localhost), no embedded credentials or fragments. */
export function validateWebhookUrl(input: string): UrlCheck {
  const value = input.trim();
  if (!value) return { ok: false, error: "Enter a webhook URL." };
  if (value.length > 2048) return { ok: false, error: "The URL is too long." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Enter a full URL, for example https://n8n.example.com/webhook/…" };
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    return { ok: false, error: "Webhook URLs must use https://." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Do not put credentials in the URL. The shared secret is sent as a header." };
  }
  if (url.hash) return { ok: false, error: "Remove the #fragment from the URL." };
  return { ok: true, url };
}

export interface ResolvedEndpoint {
  url: URL | null;
  source: EndpointStatus["source"];
  error: string | null;
}

export function resolveEndpoint(
  kind: EndpointKind,
  override: string | null | undefined,
): ResolvedEndpoint {
  if (override) {
    const check = validateWebhookUrl(override);
    return check.ok
      ? { url: check.url, source: "override", error: null }
      : { url: null, source: "override", error: `Saved ${kind} URL is invalid: ${check.error}` };
  }
  const fromEnv = process.env[ENDPOINT_ENV[kind]];
  if (fromEnv) {
    const check = validateWebhookUrl(fromEnv);
    return check.ok
      ? { url: check.url, source: "environment", error: null }
      : {
          url: null,
          source: "environment",
          error: `${ENDPOINT_ENV[kind]} is invalid: ${check.error}`,
        };
  }
  return { url: null, source: "none", error: null };
}

export function endpointStatus(kind: EndpointKind, override: string | null | undefined): EndpointStatus {
  const resolved = resolveEndpoint(kind, override);
  return { source: resolved.source, host: resolved.url?.host ?? null };
}

export function webhookSecret(): string | null {
  const secret = process.env.WEBHOOK_SECRET;
  return secret && secret.length > 0 ? secret : null;
}
