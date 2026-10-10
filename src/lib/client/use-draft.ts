"use client";

import { useCallback, useEffect, useState } from "react";
import type { Draft } from "@/lib/domain/types";
import { errorMessage } from "./api";
import { getDraft } from "./drafts";

export function useDraft(id: string) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Deferred so the first render matches the server, which cannot see browser storage.
    Promise.resolve()
      .then(() => getDraft(id))
      .then(
        (loaded) => active && setDraft(loaded),
        (err) => active && setError(errorMessage(err)),
      );
    return () => {
      active = false;
    };
  }, [id]);

  const reload = useCallback(async () => {
    try {
      const loaded = getDraft(id);
      setDraft(loaded);
      setError(null);
      return loaded;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [id]);

  return { draft, setDraft, error, reload };
}
