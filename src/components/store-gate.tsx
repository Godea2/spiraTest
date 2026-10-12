"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Spinner } from "@/components/ui";
import { startStoreSync } from "@/lib/client/store-sync";

/** Shows the app once the shared store has been loaded into this browser (or could not be reached). */
export function StoreGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void startStoreSync().then(() => active && setReady(true));
    return () => {
      active = false;
    };
  }, []);

  if (!ready) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-50 dark:bg-[#0b0c11]">
        <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-zinc-400">
          <Spinner /> Loading your workspace…
        </div>
      </div>
    );
  }
  return children;
}
