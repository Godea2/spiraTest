"use client";

import { useCallback, useEffect, useState } from "react";
import type { Draft } from "@/lib/domain/types";
import { api, errorMessage } from "./api";

export function useDraft(id: string) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ draft: Draft }>(`/api/drafts/${id}`).then(
      ({ draft: loaded }) => active && setDraft(loaded),
      (err) => active && setError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, [id]);

  const reload = useCallback(async () => {
    try {
      const { draft: loaded } = await api<{ draft: Draft }>(`/api/drafts/${id}`);
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
