import { z } from "zod";
import { PLATFORMS, type AppSettings, type TestSetMapping } from "./types";

const DEFAULT_MAPPINGS: Array<[string, number, string, TestSetMapping["platform"]]> = [
  ["Accounts", 116, "Accounts-Android", "Android"],
  ["Accounts", 117, "Accounts-iOS", "iOS"],
  ["Cards", 118, "Cards - Android", "Android"],
  ["Cards", 119, "Cards-iOS", "iOS"],
  ["Home Screen", 120, "Home Screen- Android", "Android"],
  ["Home Screen", 121, "Home Screen- iOS", "iOS"],
  ["Notifications", 122, "Notifications- Android", "Android"],
  ["Notifications", 123, "Notifications-iOS", "iOS"],
  ["Onboarding", 124, "Onboarding-Android", "Android"],
  ["Onboarding", 125, "Onboarding-IOS", "iOS"],
  ["Payments", 126, "Payments - iOS", "iOS"],
];

export function defaultSettings(): AppSettings {
  return {
    projectId: 24,
    releaseId: 157,
    releaseLabel: "1.0.0.0.0002 - Sprint3",
    mockMode: true,
    mappings: DEFAULT_MAPPINGS.map(([module, testSetId, testSetName, platform]) => ({
      id: `ts-${testSetId}`,
      module,
      testSetId,
      testSetName,
      platform,
    })),
    moduleAliases: {},
    updatedAt: null,
  };
}

export const settingsUpdateSchema = z.object({
  projectId: z.number().int().positive(),
  releaseId: z.number().int().positive(),
  releaseLabel: z.string().trim().max(200),
  mockMode: z.boolean(),
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
    mockMode: value.mockMode,
    mappings: value.mappings,
    moduleAliases,
    updatedAt: now.toISOString(),
  };
}
