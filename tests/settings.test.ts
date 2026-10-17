import { describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "@/lib/client/settings-store";
import { writeItem } from "@/lib/client/storage";
import {
  CYCLE_PRESETS,
  cycleSettingsPatch,
  detectCycle,
  findCycleFolder,
  guessMapping,
  resolveCycleRelease,
  TEAM_DEFAULTS,
  type SettingsUpdate,
} from "@/lib/domain/settings";
import type { SpiraRelease } from "@/lib/domain/types";
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
    planReleaseId: null,
    mappings: [mapping(10, "Onboarding")],
    moduleAliases: {},
    ...overrides,
  });
}

describe("settings saved in the browser", () => {
  it("starts with the team's project and releases, so a new browser needs no setup", () => {
    expect(loadSettings()).toMatchObject({ ...TEAM_DEFAULTS, mappings: [], moduleAliases: {} });
  });

  it("persists a saved update", () => {
    update({ projectId: 30, planReleaseId: 4 });
    expect(loadSettings()).toMatchObject({ projectId: 30, releaseId: 2, planReleaseId: 4 });
  });

  it("falls back to the team's project and releases when they were never chosen", () => {
    update({ projectId: null, releaseId: null });
    expect(loadSettings()).toMatchObject({ projectId: 24, releaseId: 157, releaseLabel: TEAM_DEFAULTS.releaseLabel, planReleaseId: null });
    writeItem("settings", { projectId: 24, releaseId: 157, releaseLabel: "1.0.0.0002 - Sprint3", mappings: [], moduleAliases: {} });
    expect(loadSettings().planReleaseId).toBe(156);
  });

  it("keeps another project's releases as saved, without the team's", () => {
    writeItem("settings", { projectId: 30, releaseId: null, releaseLabel: "", mappings: [], moduleAliases: {} });
    expect(loadSettings()).toMatchObject({ projectId: 30, releaseId: null, planReleaseId: null });
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
    ["Customer Onboarding & Home Screen- Android", "Customer Onboarding & Home Screen", "Android"],
    ["Accounts & Transactions- iOS", "Accounts & Transactions", "iOS"],
    ["Payments (Web)", "Payments", "Web"],
    ["Regression pack", "Regression pack", "Other"],
    ["Android", "Android", "Other"],
  ])("%s → %s / %s", (name, module, platform) => {
    expect(guessMapping(name)).toEqual({ module, platform });
  });
});

const release = (releaseId: number, versionNumber: string, label = versionNumber): SpiraRelease => ({
  releaseId,
  name: label,
  versionNumber,
  label,
  depth: 0,
  active: true,
  type: null,
});

describe("SIT / UAT testing cycles", () => {
  const releases = [
    release(156, "1.0.0.0001", "1.0.0.0001 - Sprint2"),
    release(157, "1.0.0.0002", "1.0.0.0002 - Sprint3"),
    release(160, "1.0.0.0.0004", "1.0.0.0.0004 - UAT Cycle 1"),
  ];

  it("resolves SIT and UAT by known RL id", () => {
    expect(resolveCycleRelease(releases, CYCLE_PRESETS.sit)?.releaseId).toBe(157);
    expect(resolveCycleRelease(releases, CYCLE_PRESETS.uat)?.releaseId).toBe(160);
  });

  it("applies UAT Cycle 1 (RL:160)", () => {
    expect(cycleSettingsPatch(releases, "uat")).toEqual({
      projectId: 24,
      releaseId: 160,
      releaseLabel: "1.0.0.0.0004 - UAT Cycle 1",
      planReleaseId: 156,
    });
  });

  it("detects the active cycle from the working release", () => {
    expect(detectCycle(157, releases)).toBe("sit");
    expect(detectCycle(160, releases)).toBe("uat");
    expect(detectCycle(999, releases)).toBeNull();
  });

  it("falls back to version when the UAT RL id is absent but the build exists", () => {
    const moved = [release(156, "1.0.0.0001"), release(157, "1.0.0.0002"), release(999, "1.0.0.0.0004", "1.0.0.0.0004")];
    expect(resolveCycleRelease(moved, CYCLE_PRESETS.uat)?.releaseId).toBe(999);
  });

  it("explains when UAT is missing from Spira", () => {
    expect(() => cycleSettingsPatch(releases.filter((r) => r.releaseId !== 160), "uat")).toThrow(/1\.0\.0\.0\.0004/);
  });

  it("finds the UAT - Phase 1 folder by name", () => {
    const folders = [
      { folderId: 3, name: "SIT Cycle 2" },
      { folderId: 7, name: "UAT - Phase 1" },
      { folderId: 8, name: "API UAT" },
    ];
    expect(findCycleFolder(folders, CYCLE_PRESETS.uat.folderName)).toEqual({ folderId: 7, name: "UAT - Phase 1" });
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
