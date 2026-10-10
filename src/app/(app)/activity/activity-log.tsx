"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, Notice, PageHeader, Spinner } from "@/components/ui";
import { listActivity } from "@/lib/client/activity";
import { errorMessage } from "@/lib/client/api";
import { exportActivity } from "@/lib/client/exports";
import { formatDateTime } from "@/lib/client/format";
import type { ActivityEntry } from "@/lib/domain/types";

const GROUPS: Record<string, { label: string; match: (type: string) => boolean }> = {
  all: { label: "All activity", match: () => true },
  apply: { label: "Apply and verify", match: (t) => t.startsWith("apply.") || t.startsWith("verify.") || t.startsWith("preflight.") },
  compare: { label: "Comparisons", match: (t) => t.startsWith("compare.") },
  drafts: { label: "Drafts", match: (t) => t.startsWith("draft.") },
  settings: { label: "Settings", match: (t) => t.startsWith("settings.") || t.startsWith("mock.") },
};

function tone(type: string): "danger" | "warning" | "success" | "neutral" {
  if (/failed|blocked|WithErrors/i.test(type)) return "danger";
  if (type === "apply.dryRun") return "warning";
  if (type === "apply.batch" || type === "verify.applied" || type === "preflight.passed") return "success";
  return "neutral";
}

export function ActivityLog() {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState("all");

  const load = useCallback(async () => {
    try {
      setEntries(listActivity());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(listActivity)
      .then(
        (loaded: ActivityEntry[]) => active && setEntries(loaded),
        (err) => active && setError(errorMessage(err)),
      );
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => (entries ?? []).filter((e) => GROUPS[group].match(e.type)), [entries, group]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity"
        description="Comparisons, membership checks, applies and settings changes made in this browser."
        actions={
          <>
            <Button onClick={() => void load()}>Refresh</Button>
            <Button onClick={() => exportActivity(visible)} disabled={visible.length === 0}>Export .xlsx</Button>
          </>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {entries === null && !error ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading…</div>
      ) : entries && entries.length === 0 ? (
        <EmptyState title="No activity yet">Comparisons, applies and settings changes will appear here.</EmptyState>
      ) : (
        <>
          <select className="input max-w-xs" aria-label="Filter activity" value={group} onChange={(e) => setGroup(e.target.value)}>
            {Object.entries(GROUPS).map(([key, g]) => <option key={key} value={key}>{g.label}</option>)}
          </select>
          <ol className="surface divide-y divide-zinc-100 dark:divide-zinc-800">
            {visible.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-6">
                <time className="w-32 shrink-0 text-xs text-zinc-500 tabular-nums" dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                <div className="min-w-0 flex-1 text-sm">
                  <p>{entry.message}</p>
                  {(entry.module || entry.draftId) && (
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {entry.module}
                      {entry.draftId && entry.type !== "draft.deleted" && <> · <Link className="hover:underline" href={`/drafts/${entry.draftId}`}>Open draft</Link></>}
                    </p>
                  )}
                </div>
                <Badge tone={tone(entry.type)} className="self-start font-mono">{entry.type}</Badge>
              </li>
            ))}
            {visible.length === 0 && <li className="px-5 py-4 text-sm text-zinc-500">Nothing in this category.</li>}
          </ol>
        </>
      )}
    </div>
  );
}
