import { z } from "zod";
import { PLATFORMS, type AppSettings, type Platform, type SpiraRelease } from "./types";

/**
 * The team's project and releases, used in every browser until Settings are changed there.
 * Fresh browsers start on SIT; switch to UAT (or back) with the Testing cycle control in Settings.
 * UAT is RL:160 (1.0.0.0.0004 - UAT Cycle 1), also matched by version if the id moves.
 */
export const TEAM_DEFAULTS = {
  projectId: 24,
  releaseId: 157,
  releaseLabel: "1.0.0.0002 - Sprint3",
  planReleaseId: 156,
} as const;

/** Named cycles the team flips between. SIT and UAT keep known RL ids; version is the fallback. */
export const CYCLE_PRESETS = {
  sit: {
    id: "sit" as const,
    label: "SIT",
    hint: "SIT Cycle / Phase 1 build 1.0.0.0002",
    projectId: TEAM_DEFAULTS.projectId,
    releaseId: TEAM_DEFAULTS.releaseId,
    releaseLabel: TEAM_DEFAULTS.releaseLabel,
    planReleaseId: TEAM_DEFAULTS.planReleaseId,
    versionNumber: "1.0.0.0002",
    /** Spira test-set folder name (Week loads this folder so it matches the Spira tree). */
    folderName: "SIT Cycle 2",
  },
  uat: {
    id: "uat" as const,
    label: "UAT",
    hint: "UAT - Phase 1 build 1.0.0.0.0004 (folder UAT - Phase 1)",
    projectId: TEAM_DEFAULTS.projectId,
    releaseId: 160 as number | null,
    releaseLabel: "1.0.0.0.0004 - UAT Cycle 1",
    planReleaseId: TEAM_DEFAULTS.planReleaseId,
    versionNumber: "1.0.0.0.0004",
    folderName: "UAT - Phase 1",
  },
} as const;

export type CycleId = keyof typeof CYCLE_PRESETS;

/** Finds the Spira test-set folder for a cycle name (e.g. "UAT - Phase 1"). */
export function findCycleFolder(
  folders: Array<{ folderId: number; name: string }>,
  folderName: string,
): { folderId: number; name: string } | null {
  const norm = (name: string) => name.toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(folderName);
  const exact = folders.find((f) => norm(f.name) === want);
  if (exact) return exact;
  return folders.find((f) => {
    const n = norm(f.name);
    return n.includes(want) || want.includes(n);
  }) ?? null;
}

export function defaultSettings(): AppSettings {
  return {
    ...TEAM_DEFAULTS,
    mappings: [],
    moduleAliases: {},
    updatedAt: null,
  };
}

function versionKey(version: string): string {
  return version.trim().toLowerCase();
}

/** Finds the Spira release for a cycle: known RL id first, else exact version number. */
export function resolveCycleRelease(
  releases: SpiraRelease[],
  cycle: (typeof CYCLE_PRESETS)[CycleId],
): SpiraRelease | null {
  if (cycle.releaseId !== null) {
    const byId = releases.find((r) => r.releaseId === cycle.releaseId);
    if (byId) return byId;
  }
  const want = versionKey(cycle.versionNumber);
  return releases.find((r) => versionKey(r.versionNumber) === want) ?? null;
}

/** Which cycle the current Settings release matches, if any. */
export function detectCycle(releaseId: number | null, releases: SpiraRelease[]): CycleId | null {
  if (releaseId === null) return null;
  for (const id of Object.keys(CYCLE_PRESETS) as CycleId[]) {
    const resolved = resolveCycleRelease(releases, CYCLE_PRESETS[id]);
    if (resolved?.releaseId === releaseId) return id;
  }
  const sit = CYCLE_PRESETS.sit;
  if (releaseId === sit.releaseId) return "sit";
  return null;
}

/** Project + releases to apply for a cycle. Throws when UAT (or any version-matched cycle) is missing in Spira. */
export function cycleSettingsPatch(
  releases: SpiraRelease[],
  cycleId: CycleId,
): Pick<AppSettings, "projectId" | "releaseId" | "releaseLabel" | "planReleaseId"> {
  const cycle = CYCLE_PRESETS[cycleId];
  const release = resolveCycleRelease(releases, cycle);
  if (!release) {
    throw new Error(
      `Spira has no release matching ${cycle.label} (${cycle.versionNumber}). Open the release list in Settings or check the build is planned in Project-Simba.`,
    );
  }
  return {
    projectId: cycle.projectId,
    releaseId: release.releaseId,
    releaseLabel: release.label,
    planReleaseId: cycle.planReleaseId,
  };
}

const PLATFORM_SUFFIX = /^(.*?)[\s_()[\]-]*\b(android|ios|web)\b[\s)\]]*$/i;

/**
 * Suggests a module and platform from a Spira test set name, for example
 * "Home Screen- Android" → Home Screen / Android. Names without a platform suffix
 * keep the whole name as the module.
 */
export function guessMapping(testSetName: string): { module: string; platform: Platform } {
  const name = testSetName.trim();
  const match = PLATFORM_SUFFIX.exec(name);
  if (!match || !match[1].trim()) return { module: name, platform: "Other" };
  const suffix = match[2].toLowerCase();
  const platform: Platform = suffix === "ios" ? "iOS" : suffix === "android" ? "Android" : "Web";
  return { module: match[1].trim(), platform };
}

export const settingsUpdateSchema = z.object({
  projectId: z.number().int().positive().nullable(),
  releaseId: z.number().int().positive().nullable(),
  releaseLabel: z.string().trim().max(200),
  planReleaseId: z.number().int().positive().nullable(),
  mappings: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        module: z.string().trim().min(1, "Module name is required").max(120),
        testSetId: z.number().int().positive(),
        testSetName: z.string().trim().max(200),
        platform: z.enum(PLATFORMS),
      }),
    )
    .max(500),
  moduleAliases: z.record(z.string(), z.string().trim().max(120)),
});

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export class SettingsValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super("Settings are not valid.");
  }
}

/** Validates an update and returns the settings to store. Aliases for removed modules are dropped. */
export function applySettingsUpdate(update: SettingsUpdate, now = new Date()): AppSettings {
  const parsed = settingsUpdateSchema.safeParse(update);
  const errors: Record<string, string> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[issue.path.join(".") || "_"] ??= issue.message;
    throw new SettingsValidationError(errors);
  }
  const value = parsed.data;

  const seen = new Set<number>();
  value.mappings.forEach((mapping, index) => {
    if (seen.has(mapping.testSetId)) {
      errors[`mappings.${index}.testSetId`] = `Test set ${mapping.testSetId} is mapped more than once.`;
    }
    seen.add(mapping.testSetId);
  });
  if (Object.keys(errors).length > 0) throw new SettingsValidationError(errors);

  const modules = new Set(value.mappings.map((m) => m.module));
  const moduleAliases: Record<string, string> = {};
  for (const [module, alias] of Object.entries(value.moduleAliases)) {
    if (modules.has(module) && alias) moduleAliases[module] = alias;
  }

  return {
    projectId: value.projectId,
    releaseId: value.releaseId,
    releaseLabel: value.releaseLabel,
    planReleaseId: value.planReleaseId,
    mappings: value.mappings,
    moduleAliases,
    updatedAt: now.toISOString(),
  };
}
