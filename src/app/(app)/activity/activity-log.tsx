"use client";

import clsx from "clsx";
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  FileText,
  GitCompareArrows,
  History,
  RefreshCw,
  Settings2,
  ShieldCheck,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, Notice, PageHeader } from "@/components/ui";
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
  settings: { label: "Settings", match: (t) => t.startsWith("settings.") || t.startsWith("spira.") },
};

function tone(type: string): "danger" | "warning" | "success" | "neutral" {
  if (/failed|blocked|WithErrors/i.test(type)) return "danger";
  if (type === "apply.dryRun") return "warning";
  if (type === "apply.batch" || type === "verify.applied" || type === "preflight.passed") return "success";
  return "neutral";
}

const TONE_ICON = {
  danger: "bg-red-50 text-red-600 ring-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20",
  warning: "bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
  success: "bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  neutral: "bg-slate-100 text-slate-500 ring-slate-200 dark:bg-white/[0.06] dark:text-zinc-400 dark:ring-white/10",
} as const;

function iconFor(type: string): LucideIcon {
  if (/failed|WithErrors/i.test(type)) return XCircle;
  if (type.startsWith("compare.")) return GitCompareArrows;
  if (type.startsWith("preflight.") || type.startsWith("verify.")) return ShieldCheck;
  if (type.startsWith("apply.")) return type === "apply.batch" ? CheckCircle2 : Zap;
  if (type.startsWith("settings.") || type.startsWith("spira.")) return Settings2;
  return FileText;
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
            <Button icon={RefreshCw} onClick={() => void load()}>Refresh</Button>
            <Button icon={Download} onClick={() => exportActivity(visible)} disabled={visible.length === 0}>Export .xlsx</Button>
          </>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {entries === null && !error ? (
        <div className="surface flex flex-col gap-4 p-5">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-lg" />)}
        </div>
      ) : entries && entries.length === 0 ? (
        <EmptyState icon={History} title="No activity yet">Comparisons, applies and settings changes will appear here.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Filter activity">
            {Object.entries(GROUPS).map(([key, g]) => {
              const count = (entries ?? []).filter((e) => g.match(e.type)).length;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={group === key}
                  onClick={() => setGroup(key)}
                  className={clsx(
                    "inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium ring-1 transition",
                    group === key
                      ? "bg-slate-900 text-white ring-slate-900 dark:bg-white dark:text-zinc-900 dark:ring-white"
                      : "bg-white text-slate-600 ring-slate-200 hover:text-slate-900 dark:bg-white/[0.03] dark:text-zinc-400 dark:ring-white/10 dark:hover:text-white",
                  )}
                >
                  {g.label}
                  <span className="text-xs tabular-nums opacity-60">{count}</span>
                </button>
              );
            })}
          </div>
          <ol className="surface relative p-2 sm:p-3">
            {visible.map((entry) => {
              const t = tone(entry.type);
              const Icon = iconFor(entry.type);
              return (
                <li key={entry.id} className="relative flex gap-4 rounded-xl px-3 py-3 transition hover:bg-slate-50/80 dark:hover:bg-white/[0.02]">
                  <span className={clsx("grid size-8 shrink-0 place-items-center rounded-full ring-1", TONE_ICON[t])}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <p className="text-sm">{entry.message}</p>
                      <time className="shrink-0 text-xs text-slate-500 tabular-nums" dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <Badge tone={t} className="font-mono">{entry.type}</Badge>
                      {entry.module && <span>{entry.module}</span>}
                      {entry.draftId && entry.type !== "draft.deleted" && (
                        <Link className="inline-flex items-center gap-0.5 font-medium text-brand-600 hover:underline dark:text-brand-300" href={`/drafts/${entry.draftId}`}>
                          Open draft <ArrowUpRight className="size-3" aria-hidden />
                        </Link>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
            {visible.length === 0 && <li className="px-3 py-4 text-sm text-slate-500">Nothing in this category.</li>}
          </ol>
        </>
      )}
    </div>
  );
}
