import "server-only";
import { z } from "zod";
import { PLATFORMS, type PublicSettings, type TestSetMapping } from "@/lib/domain/types";
import { endpointStatus, validateWebhookUrl, webhookSecret } from "./endpoints";
import { dataPath, readJson, withFileLock, writeJson } from "./json-store";

export interface StoredSettings {
  version: 1;
  projectId: number;
  releaseId: number;
  releaseLabel: string;
  mockMode: boolean;
  mappings: TestSetMapping[];
  moduleAliases: Record<string, string>;
  endpoints: { reconcileUrl: string | null; applyUrl: string | null };
  updatedAt: string | null;
}

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

export function defaultSettings(): StoredSettings {
  return {
    version: 1,
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
    endpoints: { reconcileUrl: null, applyUrl: null },
    updatedAt: null,
  };
}

const settingsFile = () => dataPath("settings.json");

export async function getSettings(): Promise<StoredSettings> {
  const stored = await readJson<Partial<StoredSettings>>(settingsFile());
  if (!stored) return defaultSettings();
  const defaults = defaultSettings();
  return {
    ...defaults,
    ...stored,
    endpoints: { ...defaults.endpoints, ...(stored.endpoints ?? {}) },
    moduleAliases: stored.moduleAliases ?? {},
    mappings: stored.mappings ?? defaults.mappings,
    version: 1,
  };
}

export function toPublicSettings(settings: StoredSettings): PublicSettings {
  return {
    projectId: settings.projectId,
    releaseId: settings.releaseId,
    releaseLabel: settings.releaseLabel,
    mockMode: settings.mockMode,
    mappings: settings.mappings,
    moduleAliases: settings.moduleAliases,
    endpoints: {
      reconcile: endpointStatus("reconcile", settings.endpoints.reconcileUrl),
      apply: endpointStatus("apply", settings.endpoints.applyUrl),
    },
    webhookSecretConfigured: webhookSecret() !== null,
    updatedAt: settings.updatedAt,
  };
}

const endpointChange = z
  .object({
    url: z.string().max(4096).optional(),
    clear: z.boolean().optional(),
  })
  .optional();

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
  endpoints: z
    .object({ reconcile: endpointChange, apply: endpointChange })
    .optional(),
});

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export class SettingsValidationError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super("Settings are not valid.");
  }
}

function applyEndpointChange(
  current: string | null,
  change: { url?: string; clear?: boolean } | undefined,
  field: string,
  errors: Record<string, string>,
): string | null {
  if (!change) return current;
  if (change.clear) return null;
  const url = change.url?.trim();
  if (!url) return current;
  const check = validateWebhookUrl(url);
  if (!check.ok) {
    errors[field] = check.error;
    return current;
  }
  return check.url.toString();
}

export async function updateSettings(update: SettingsUpdate): Promise<StoredSettings> {
  return withFileLock(settingsFile(), async () => {
    const current = await getSettings();
    const errors: Record<string, string> = {};

    const seen = new Set<number>();
    update.mappings.forEach((mapping, index) => {
      if (seen.has(mapping.testSetId)) {
        errors[`mappings.${index}.testSetId`] = `Test set ${mapping.testSetId} is mapped more than once.`;
      }
      seen.add(mapping.testSetId);
    });

    const modules = new Set(update.mappings.map((m) => m.module));
    const moduleAliases: Record<string, string> = {};
    for (const [module, alias] of Object.entries(update.moduleAliases)) {
      if (modules.has(module) && alias) moduleAliases[module] = alias;
    }

    const endpoints = {
      reconcileUrl: applyEndpointChange(
        current.endpoints.reconcileUrl,
        update.endpoints?.reconcile,
        "endpoints.reconcile",
        errors,
      ),
      applyUrl: applyEndpointChange(
        current.endpoints.applyUrl,
        update.endpoints?.apply,
        "endpoints.apply",
        errors,
      ),
    };

    if (Object.keys(errors).length > 0) throw new SettingsValidationError(errors);

    const next: StoredSettings = {
      version: 1,
      projectId: update.projectId,
      releaseId: update.releaseId,
      releaseLabel: update.releaseLabel,
      mockMode: update.mockMode,
      mappings: update.mappings,
      moduleAliases,
      endpoints,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(settingsFile(), next);
    return next;
  });
}

export function mappingsForModule(settings: StoredSettings, module: string): TestSetMapping[] {
  return settings.mappings.filter((m) => m.module === module);
}
