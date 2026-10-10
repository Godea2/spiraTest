import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateWebhookUrl } from "@/lib/server/endpoints";
import { n8nApply, n8nReconcile } from "@/lib/server/n8n";
import { defaultSettings, getSettings, toPublicSettings, updateSettings } from "@/lib/server/settings-store";
import { createSessionToken, verifySessionToken } from "@/lib/server/session";

const ENV_KEYS = ["RECONCILE_WEBHOOK_URL", "APPLY_WEBHOOK_URL", "WEBHOOK_SECRET", "SESSION_SECRET", "APP_PASSWORD"];
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
  vi.unstubAllGlobals();
});

function update(overrides: Partial<Parameters<typeof updateSettings>[0]> = {}) {
  const { projectId, releaseId, releaseLabel, mockMode, mappings, moduleAliases } = defaultSettings();
  return updateSettings({ projectId, releaseId, releaseLabel, mockMode, mappings, moduleAliases, ...overrides });
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

describe("settings", () => {
  it("defaults to project 24 / release 157 with Mock mode on and 11 mappings", async () => {
    const settings = await getSettings();
    expect(settings).toMatchObject({ projectId: 24, releaseId: 157, releaseLabel: "1.0.0.0.0002 - Sprint3", mockMode: true });
    expect(settings.mappings).toHaveLength(11);
    expect(settings.mappings.find((m) => m.testSetId === 126)).toMatchObject({ module: "Payments", platform: "iOS" });
  });

  it("saves an override, keeps it when the field is blank, and clears back to the environment fallback", async () => {
    process.env.RECONCILE_WEBHOOK_URL = "https://env.example.com/webhook/reconcile";
    await update({ endpoints: { reconcile: { url: "https://override.example.com/webhook/r" } } });
    expect(toPublicSettings(await getSettings()).endpoints.reconcile).toEqual({ source: "override", host: "override.example.com" });

    await update({ endpoints: { reconcile: { url: "  " } } });
    expect((await getSettings()).endpoints.reconcileUrl).toBe("https://override.example.com/webhook/r");

    await update({ endpoints: { reconcile: { clear: true } } });
    expect(toPublicSettings(await getSettings()).endpoints.reconcile).toEqual({ source: "environment", host: "env.example.com" });
  });

  it("never exposes full URLs or the secret in the public settings", async () => {
    process.env.WEBHOOK_SECRET = "super-secret-value";
    await update({ endpoints: { apply: { url: "https://n8n.example.com/webhook/apply-token-123" } } });
    const json = JSON.stringify(toPublicSettings(await getSettings()));
    expect(json).not.toContain("apply-token-123");
    expect(json).not.toContain("super-secret-value");
    expect(json).toContain('"webhookSecretConfigured":true');
  });

  it("rejects invalid URLs and duplicate test sets with field errors", async () => {
    await expect(update({ endpoints: { apply: { url: "http://n8n.example.com/x" } } })).rejects.toMatchObject({
      fieldErrors: { "endpoints.apply": expect.stringContaining("https") },
    });
    const mappings = defaultSettings().mappings;
    await expect(update({ mappings: [...mappings, { ...mappings[0], id: "dup" }] })).rejects.toMatchObject({
      fieldErrors: { "mappings.11.testSetId": expect.stringContaining("more than once") },
    });
  });

  it("drops aliases for modules that no longer have mappings", async () => {
    await update({ moduleAliases: { Onboarding: "Onboarding App", Ghost: "x" } });
    expect((await getSettings()).moduleAliases).toEqual({ Onboarding: "Onboarding App" });
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
