import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings } from "@/lib/client/settings-store";
import { defaultSettings, type SettingsUpdate } from "@/lib/domain/settings";
import {
  applyEndpointChanges,
  decryptOverrides,
  encryptOverrides,
  NO_OVERRIDES,
  toEndpointsStatus,
} from "@/lib/server/endpoint-overrides";
import { validateWebhookUrl } from "@/lib/server/endpoints";
import { n8nApply, n8nReconcile } from "@/lib/server/n8n";
import { createSessionToken, verifySessionToken } from "@/lib/server/session";

const ENV_KEYS = ["RECONCILE_WEBHOOK_URL", "APPLY_WEBHOOK_URL", "WEBHOOK_SECRET", "APP_PASSWORD"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function update(overrides: Partial<SettingsUpdate> = {}) {
  const { projectId, releaseId, releaseLabel, mockMode, mappings, moduleAliases } = defaultSettings();
  return saveSettings({ projectId, releaseId, releaseLabel, mockMode, mappings, moduleAliases, ...overrides });
}

describe("webhook URL validation", () => {
  it.each([
    ["https://n8n.example.com/webhook/reconcile", true],
    ["http://localhost:5678/webhook/x", true],
    ["http://n8n.example.com/webhook/x", false],
    ["https://user:pass@n8n.example.com/webhook", false],
    ["https://n8n.example.com/webhook#frag", false],
    ["not a url", false],
  ])("%s → %s", (url, valid) => {
    expect(validateWebhookUrl(url).ok).toBe(valid);
  });
});

describe("settings saved in the browser", () => {
  it("defaults to project 24 / release 157 with Mock mode on and 11 mappings", () => {
    const settings = loadSettings();
    expect(settings).toMatchObject({ projectId: 24, releaseId: 157, releaseLabel: "1.0.0.0.0002 - Sprint3", mockMode: true });
    expect(settings.mappings).toHaveLength(11);
    expect(settings.mappings.find((m) => m.testSetId === 126)).toMatchObject({ module: "Payments", platform: "iOS" });
  });

  it("persists a saved update", () => {
    update({ projectId: 30, mockMode: false });
    expect(loadSettings()).toMatchObject({ projectId: 30, mockMode: false });
  });

  it("rejects duplicate test sets with a field error and keeps the previous settings", () => {
    const mappings = defaultSettings().mappings;
    expect(() => update({ mappings: [...mappings, { ...mappings[0], id: "dup" }] })).toThrow(
      expect.objectContaining({ fieldErrors: { "mappings.11.testSetId": expect.stringContaining("more than once") } }),
    );
    expect(loadSettings().mappings).toHaveLength(11);
  });

  it("drops aliases for modules that no longer have mappings", () => {
    update({ moduleAliases: { Onboarding: "Onboarding App", Ghost: "x" } });
    expect(loadSettings().moduleAliases).toEqual({ Onboarding: "Onboarding App" });
  });
});

describe("webhook URL overrides", () => {
  it("saves an override, keeps it when the field is blank, and clears back to the environment fallback", () => {
    process.env.RECONCILE_WEBHOOK_URL = "https://env.example.com/webhook/reconcile";
    let overrides = applyEndpointChanges(NO_OVERRIDES, { reconcile: { url: "https://override.example.com/webhook/r" } });
    expect(toEndpointsStatus(overrides).endpoints.reconcile).toEqual({ source: "override", host: "override.example.com" });

    overrides = applyEndpointChanges(overrides, { reconcile: { url: "  " } });
    expect(overrides.reconcileUrl).toBe("https://override.example.com/webhook/r");

    overrides = applyEndpointChanges(overrides, { reconcile: { clear: true } });
    expect(toEndpointsStatus(overrides).endpoints.reconcile).toEqual({ source: "environment", host: "env.example.com" });
  });

  it("never exposes full URLs or the secret in the endpoint status", () => {
    process.env.WEBHOOK_SECRET = "super-secret-value";
    const overrides = applyEndpointChanges(NO_OVERRIDES, { apply: { url: "https://n8n.example.com/webhook/apply-token-123" } });
    const json = JSON.stringify(toEndpointsStatus(overrides));
    expect(json).not.toContain("apply-token-123");
    expect(json).not.toContain("super-secret-value");
    expect(json).toContain('"webhookSecretConfigured":true');
  });

  it("rejects invalid URLs with a field error", () => {
    expect(() => applyEndpointChanges(NO_OVERRIDES, { apply: { url: "http://n8n.example.com/x" } })).toThrow(
      expect.objectContaining({ fieldErrors: { "endpoints.apply": expect.stringContaining("https") } }),
    );
  });

  it("stores overrides encrypted, readable only with the current session secret", async () => {
    const overrides = { reconcileUrl: "https://n8n.example.com/webhook/reconcile-token-9", applyUrl: null };
    const cookie = await encryptOverrides(overrides);
    expect(cookie).not.toContain("reconcile-token-9");
    expect(await decryptOverrides(cookie)).toEqual(overrides);

    process.env.SESSION_SECRET = "a-different-secret-0123456789";
    expect(await decryptOverrides(cookie)).toEqual(NO_OVERRIDES);
    expect(await decryptOverrides("garbage")).toEqual(NO_OVERRIDES);
  });
});

describe("n8n contract", () => {
  const request = {
    projectId: 24,
    releaseId: 157,
    module: "Onboarding",
    testSetId: 125,
    testSetName: "Onboarding-IOS",
    platform: "iOS" as const,
    rows: [],
  };

  it("sends the secret as X-Webhook-Secret and normalises the response", async () => {
    process.env.WEBHOOK_SECRET = "s3cret";
    const fetchMock = vi.fn(async () =>
      Response.json({
        cards: [{ testCaseId: "3519", testSetTestCaseId: 12318, name: "A", suggestion: "Out of Scope", executionStatus: "Passed" }],
        missingFromSpira: [{ tcId: "ONB-9", testScenario: "Missing" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await n8nReconcile("https://n8n.example.com/webhook/r", request);
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)["X-Webhook-Secret"]).toBe("s3cret");
    expect(out.cards[0]).toMatchObject({ key: "125:12318", testCaseId: 3519, suggestion: "outOfScope", executed: true });
    expect(out.membership).toEqual([12318]);
  });

  it("refuses to call n8n without WEBHOOK_SECRET", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(n8nReconcile("https://n8n.example.com/webhook/r", request)).rejects.toThrow(/WEBHOOK_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, /WEBHOOK_SECRET matches/],
    [404, /not found/],
    [500, /HTTP 500/],
  ])("maps HTTP %i to an actionable error", async (status, message) => {
    process.env.WEBHOOK_SECRET = "s3cret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status })));
    await expect(n8nReconcile("https://n8n.example.com/webhook/r", request)).rejects.toThrow(message);
  });

  it("reports schema mismatches", async () => {
    process.env.WEBHOOK_SECRET = "s3cret";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ rows: [] })));
    await expect(n8nReconcile("https://n8n.example.com/webhook/r", request)).rejects.toThrow(/unexpected shape/);
  });

  it("treats unreported apply actions as failed so they can be retried", async () => {
    process.env.WEBHOOK_SECRET = "s3cret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ results: [{ testSetTestCaseId: 1, status: "wouldRemove" }] })),
    );
    const results = await n8nApply("https://n8n.example.com/webhook/a", {
      projectId: 24,
      releaseId: 157,
      testSetId: 125,
      dryRun: true,
      actions: [
        { testCaseId: 10, testSetTestCaseId: 1 },
        { testCaseId: 11, testSetTestCaseId: 2 },
      ],
    });
    expect(results.map((r) => r.status)).toEqual(["wouldRemove", "failed"]);
  });
});

describe("session tokens", () => {
  it("verifies tokens signed with the current secret only", async () => {
    process.env.SESSION_SECRET = "a".repeat(32);
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
    process.env.SESSION_SECRET = "b".repeat(32);
    expect(await verifySessionToken(token)).toBe(false);
    expect(await verifySessionToken("garbage")).toBe(false);
  });
});
