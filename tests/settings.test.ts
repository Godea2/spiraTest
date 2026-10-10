import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "@/lib/client/settings-store";
import { writeItem } from "@/lib/client/storage";
import { guessMapping, type SettingsUpdate } from "@/lib/domain/settings";
import { createSessionToken, verifySessionToken } from "@/lib/server/session";

const mapping = (testSetId: number, module: string) => ({
  id: `m-${testSetId}`,
  module,
  testSetId,
  testSetName: `${module} set`,
  platform: "Android" as const,
});

function update(overrides: Partial<SettingsUpdate> = {}) {
  return saveSettings({
    projectId: 1,
    releaseId: 2,
    releaseLabel: "",
    mappings: [mapping(10, "Onboarding")],
    moduleAliases: {},
    keywords: [],
    ...overrides,
  });
}

describe("settings saved in the browser", () => {
  it("starts empty: no project, release or test sets until chosen", () => {
    expect(loadSettings()).toMatchObject({ projectId: null, releaseId: null, releaseLabel: "", mappings: [], moduleAliases: {} });
  });

  it("persists a saved update", () => {
    update({ projectId: 30 });
    expect(loadSettings()).toMatchObject({ projectId: 30, releaseId: 2 });
  });

  it("allows saving without a project or release", () => {
    update({ projectId: null, releaseId: null });
    expect(loadSettings()).toMatchObject({ projectId: null, releaseId: null });
  });

  it("ignores the Mock mode flag from older saved settings", () => {
    writeItem("settings", { projectId: 5, releaseId: 6, releaseLabel: "", mappings: [], moduleAliases: {}, mockMode: true });
    expect(loadSettings()).not.toHaveProperty("mockMode");
  });

  it("rejects duplicate test sets with a field error and keeps the previous settings", () => {
    update();
    expect(() => update({ mappings: [mapping(10, "Onboarding"), { ...mapping(10, "Cards"), id: "dup" }] })).toThrow(
      expect.objectContaining({ fieldErrors: { "mappings.1.testSetId": expect.stringContaining("more than once") } }),
    );
    expect(loadSettings().mappings).toHaveLength(1);
  });

  it("saves not-implemented keywords without blanks or case-insensitive duplicates", () => {
    update({ keywords: [" NIN ", "bvn", "nin", "", "Google  Sign-in"] });
    expect(loadSettings().keywords).toEqual(["NIN", "bvn", "Google Sign-in"]);
  });

  it("loads older settings without keywords as an empty list", () => {
    writeItem("settings", { projectId: 5, releaseId: 6, releaseLabel: "", mappings: [], moduleAliases: {} });
    expect(loadSettings().keywords).toEqual([]);
  });

  it("drops aliases for modules that no longer have mappings", () => {
    update({ moduleAliases: { Onboarding: "Onboarding App", Ghost: "x" } });
    expect(loadSettings().moduleAliases).toEqual({ Onboarding: "Onboarding App" });
  });
});

describe("module and platform suggested from a Spira test set name", () => {
  it.each([
    ["Onboarding-IOS", "Onboarding", "iOS"],
    ["Cards - Android", "Cards", "Android"],
    ["Home Screen- iOS", "Home Screen", "iOS"],
    ["Payments (Web)", "Payments", "Web"],
    ["Regression pack", "Regression pack", "Other"],
    ["Android", "Android", "Other"],
  ])("%s → %s / %s", (name, module, platform) => {
    expect(guessMapping(name)).toEqual({ module, platform });
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
