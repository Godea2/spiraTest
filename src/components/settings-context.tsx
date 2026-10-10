"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/client/api";
import type { PublicSettings } from "@/lib/domain/types";

interface SettingsState {
  settings: PublicSettings | null;
  error: string | null;
  reload: () => Promise<void>;
  replace: (settings: PublicSettings) => void;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSettings(await api<PublicSettings>("/api/settings"));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    api<PublicSettings>("/api/settings").then(
      (loaded) => active && setSettings(loaded),
      (err) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, error, reload, replace: setSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsState {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider");
  return value;
}

export function modulesFrom(settings: PublicSettings | null): string[] {
  if (!settings) return [];
  return [...new Set(settings.mappings.map((m) => m.module))].sort((a, b) => a.localeCompare(b));
}
