import { applySettingsUpdate, defaultSettings, type SettingsUpdate } from "@/lib/domain/settings";
import type { AppSettings } from "@/lib/domain/types";
import { readItem, writeItem } from "./storage";

const KEY = "settings";

export function loadSettings(): AppSettings {
  const stored = readItem<Partial<AppSettings>>(KEY);
  const defaults = defaultSettings();
  if (!stored) return defaults;
  return {
    projectId: typeof stored.projectId === "number" ? stored.projectId : defaults.projectId,
    releaseId: typeof stored.releaseId === "number" ? stored.releaseId : defaults.releaseId,
    releaseLabel: stored.releaseLabel ?? defaults.releaseLabel,
    mappings: stored.mappings ?? defaults.mappings,
    moduleAliases: stored.moduleAliases ?? {},
    updatedAt: stored.updatedAt ?? null,
  };
}

/** Throws SettingsValidationError with field errors when the update is not valid. */
export function saveSettings(update: SettingsUpdate): AppSettings {
  const next = applySettingsUpdate(update);
  writeItem(KEY, next);
  return next;
}
