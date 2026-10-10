import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "@/lib/client/settings-store";
import { writeItem } from "@/lib/client/storage";
import { defaultSettings, type SettingsUpdate } from "@/lib/domain/settings";
import { createSessionToken, verifySessionToken } from "@/lib/server/session";

function update(overrides: Partial<SettingsUpdate> = {}) {
  const { projectId, releaseId, releaseLabel, mappings, moduleAliases } = defaultSettings();
  return saveSettings({ projectId, releaseId, releaseLabel, mappings, moduleAliases, ...overrides });
}

describe("settings saved in the browser", () => {
  it("defaults to project 24 / release 157 with 11 mappings", () => {
    const settings = loadSettings();
    expect(settings).toMatchObject({ projectId: 24, releaseId: 157, releaseLabel: "1.0.0.0.0002 - Sprint3" });
    expect(settings.mappings).toHaveLength(11);
    expect(settings.mappings.find((m) => m.testSetId === 126)).toMatchObject({ module: "Payments", platform: "iOS" });
  });

  it("persists a saved update", () => {
    update({ projectId: 30 });
    expect(loadSettings()).toMatchObject({ projectId: 30 });
  });

  it("ignores the Mock mode flag from older saved settings", () => {
    writeItem("settings", { ...defaultSettings(), mockMode: true });
    expect(loadSettings()).not.toHaveProperty("mockMode");
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
