"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { loadSettings } from "@/lib/client/settings-store";
import type { AppSettings, EndpointsStatus } from "@/lib/domain/types";

interface SettingsState {
  /** Saved in this browser. */
  settings: AppSettings | null;
  /** Webhook configuration as reported by the server (source and host only). */
  endpoints: EndpointsStatus | null;
  endpointsError: string | null;
  replace: (settings: AppSettings) => void;
  replaceEndpoints: (endpoints: EndpointsStatus) => void;
  reloadEndpoints: () => Promise<void>;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointsStatus | null>(null);
  const [endpointsError, setEndpointsError] = useState<string | null>(null);

  const reloadEndpoints = useCallback(async () => {
    try {
      setEndpoints(await api<EndpointsStatus>("/api/endpoints"));
      setEndpointsError(null);
    } catch (err) {
      setEndpointsError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && setSettings(loadSettings()));
    api<EndpointsStatus>("/api/endpoints").then(
      (loaded) => active && setEndpoints(loaded),
      (err) => active && setEndpointsError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <SettingsContext.Provider
      value={{ settings, endpoints, endpointsError, replace: setSettings, replaceEndpoints: setEndpoints, reloadEndpoints }}
    >
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
