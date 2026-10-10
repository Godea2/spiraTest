import { applySettingsUpdate, defaultSettings, type SettingsUpdate } from "@/lib/domain/settings";
import type { AppSettings } from "@/lib/domain/types";
import { readItem, writeItem } from "./storage";

const KEY = "settings";

export function loadSettings(): AppSettings {
  const stored = readItem<Partial<AppSettings>>(KEY);
  const defaults = defaultSettings();
  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    mappings: stored.mappings ?? defaults.mappings,
    moduleAliases: stored.moduleAliases ?? {},
  };
}

/** Throws SettingsValidationError with field errors when the update is not valid. */
export function saveSettings(update: SettingsUpdate): AppSettings {
  const next = applySettingsUpdate(update);
  writeItem(KEY, next);
  return next;
}
