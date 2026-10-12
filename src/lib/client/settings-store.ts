import { applySettingsUpdate, defaultSettings, type SettingsUpdate } from "@/lib/domain/settings";
import type { AppSettings } from "@/lib/domain/types";
import { readItem, writeItem } from "./storage";

const KEY = "settings";

const id = (value: unknown) => (typeof value === "number" ? value : null);

/** Saved settings, with the team's project and releases filling whatever was never chosen in this browser. */
export function loadSettings(): AppSettings {
  const stored = readItem<Partial<AppSettings>>(KEY);
  const defaults = defaultSettings();
  if (!stored) return defaults;
  const projectId = id(stored.projectId) ?? defaults.projectId;
  const teamProject = projectId === defaults.projectId;
  const releaseId = id(stored.releaseId) ?? (teamProject ? defaults.releaseId : null);
  return {
    projectId,
    releaseId,
    releaseLabel: id(stored.releaseId) !== null ? (stored.releaseLabel ?? "") : teamProject ? defaults.releaseLabel : "",
    planReleaseId: "planReleaseId" in stored ? id(stored.planReleaseId) : teamProject ? defaults.planReleaseId : null,
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
