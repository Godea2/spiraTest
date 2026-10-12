"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { purgeMockData } from "@/lib/client/drafts";
import { loadSettings } from "@/lib/client/settings-store";
import { SYNCED_EVENT } from "@/lib/client/store-sync";
import type { AiStatus, AppSettings, SpiraStatus } from "@/lib/domain/types";

interface SettingsState {
  /** Saved in this browser. */
  settings: AppSettings | null;
  /** Spira connection as configured on the server (host and username only). */
  spira: SpiraStatus | null;
  spiraError: string | null;
  /** Gemini AI review as configured on the server (model only). */
  ai: AiStatus | null;
  replace: (settings: AppSettings) => void;
  reloadSpira: () => Promise<void>;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [spira, setSpira] = useState<SpiraStatus | null>(null);
  const [spiraError, setSpiraError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);

  const reloadSpira = useCallback(async () => {
    try {
      setSpira(await api<SpiraStatus>("/api/spira"));
      setSpiraError(null);
    } catch (err) {
      setSpiraError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (!active) return;
      purgeMockData();
      setSettings(loadSettings());
    });
    api<SpiraStatus>("/api/spira").then(
      (loaded) => active && setSpira(loaded),
      (err) => active && setSpiraError(errorMessage(err)),
    );
    api<AiStatus>("/api/ai").then(
      (loaded) => active && setAi(loaded),
      () => active && setAi({ configured: false, model: "" }),
    );
    const onSynced = (event: Event) => {
      if ((event as CustomEvent<string[]>).detail.includes("settings")) setSettings(loadSettings());
    };
    window.addEventListener(SYNCED_EVENT, onSynced);
    return () => {
      active = false;
      window.removeEventListener(SYNCED_EVENT, onSynced);
    };
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, spira, spiraError, ai, replace: setSettings, reloadSpira }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsState {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider");
  return value;
}

export function modulesFrom(settings: AppSettings | null): string[] {
  if (!settings) return [];
  return [...new Set(settings.mappings.map((m) => m.module))].sort((a, b) => a.localeCompare(b));
}
