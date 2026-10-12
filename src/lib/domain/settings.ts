import { z } from "zod";
import { PLATFORMS, type AppSettings, type Platform } from "./types";

/**
 * The team's project and releases, used in every browser until Settings are changed there:
 * Project-Simba, Phase 1 in 1.0.0.0002 (Sprint3) and the total test plan in 1.0.0.0001 (Sprint2).
 */
export const TEAM_DEFAULTS = {
  projectId: 24,
  releaseId: 157,
  releaseLabel: "1.0.0.0002 - Sprint3",
  planReleaseId: 156,
} as const;

export function defaultSettings(): AppSettings {
  return {
    ...TEAM_DEFAULTS,
    mappings: [],
    moduleAliases: {},
    updatedAt: null,
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
