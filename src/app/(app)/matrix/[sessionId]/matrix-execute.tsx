"use client";

import clsx from "clsx";
import { ArrowLeft, RotateCcw, Search, Smartphone, UserRound } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section } from "@/components/ui";
import { storeEnvironment } from "@/lib/client/defects";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  clearMatrixResult,
  environmentLabel,
  getMatrixSession,
  loadMatrixStore,
  MATRIX_PACK_LABEL,
  modulesInSession,
  recordMatrixResult,
  resultsForSession,
  sessionCounts,
  type MatrixCase,
  type MatrixResult,
  type MatrixSession,
  type MatrixStore,
} from "@/lib/client/matrix";
import { STATUS_LABEL } from "@/lib/domain/execution";
import { EXECUTION_STATUSES, type ExecutionStatus } from "@/lib/domain/types";
import { StatusChip, STATUS_STYLE } from "../../drafts/[id]/execute/runner";

type Filter = "all" | "notRun" | ExecutionStatus;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "notRun", label: "To run" },
  { id: "passed", label: "Passed" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
  { id: "caution", label: "Caution" },
  { id: "all", label: "All" },
];

export function MatrixExecute() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;
  const { settings } = useSettings();
  const projectId = settings?.projectId ?? null;

  const [store, setStore] = useState<MatrixStore | null>(null);
  const [session, setSession] = useState<MatrixSession | null>(null);
  const [tester, setTester] = useState("");
  const [filter, setFilter] = useState<Filter>("notRun");
  const [moduleTab, setModuleTab] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setTester(getTester());
  }, []);

  useEffect(() => {
    if (projectId === null) return;
    const next = loadMatrixStore(projectId);
    setStore(next);
    const s = getMatrixSession(projectId, sessionId);
    setSession(s);
    setMissing(!s);
    if (s?.module) setModuleTab(s.module);
  }, [projectId, sessionId]);

  const resultMap = useMemo(() => (store && session ? resultsForSession(store, session) : new Map<string, MatrixResult>()), [store, session]);
  const counts = useMemo(() => (session && store ? sessionCounts(session, store.results) : null), [session, store]);
  const moduleRows = useMemo(() => (session ? modulesInSession(session.cases) : []), [session]);

  const visible = useMemo(() => {
    if (!session) return [];
    const q = query.trim().toLowerCase();
    return session.cases.filter((c) => {
      if (moduleTab !== "all" && c.module !== moduleTab) return false;
      if (q && !`${c.name} TC${c.testCaseId} ${c.module} ${c.testSetName}`.toLowerCase().includes(q)) return false;
      const r = resultMap.get(c.key);
      if (filter === "all") return true;
      if (filter === "notRun") return !r;
      return r?.status === filter;
    });
  }, [session, query, filter, resultMap, moduleTab]);

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };

  const mark = (card: MatrixCase, status: ExecutionStatus) => {
    if (projectId === null || !session) return;
    const next = recordMatrixResult({
      projectId,
      sessionId: session.id,
      caseKey: card.key,
      status,
      comment,
      tester,
    });
    setStore(next);
    setComment("");
    storeEnvironment(`${environmentLabel(session.device, session.network)} · ${session.releaseLabel}`);
    toast.success(`${STATUS_LABEL[status]} · TC${card.testCaseId}`);
    const remaining = visible.filter((c) => c.key !== card.key && !resultsForSession(next, session).has(c.key));
    setOpenKey(remaining[0]?.key ?? null);
  };

  const clear = (card: MatrixCase) => {
    if (projectId === null || !session) return;
    setStore(clearMatrixResult(projectId, session.id, card.key));
    toast.message(`Cleared TC${card.testCaseId}`);
  };

  if (projectId === null) {
    return (
      <EmptyState icon={Smartphone} title="No project" action={<ButtonLink href="/settings">Open Settings</ButtonLink>}>
        Save Settings, then open Matrix again.
      </EmptyState>
    );
  }

  if (missing || !session) {
    return (
      <EmptyState icon={Smartphone} title="Session not found" action={<ButtonLink href="/matrix">Back to Matrix</ButtonLink>}>
        That matrix session is missing or was removed.
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
      <PageHeader
        title={environmentLabel(session.device, session.network)}
        description={`${MATRIX_PACK_LABEL[session.pack]}${session.module ? ` · ${session.module}` : ""} · ${session.releaseLabel} · Exact Spira cases · Marks stay in this app`}
        actions={
          <ButtonLink href="/matrix" size="sm" icon={ArrowLeft}>
            Matrix
          </ButtonLink>
        }
      />

      <Notice tone="info">
        You are executing on <strong>{session.device}</strong> with <strong>{session.network}</strong>. Same Spira modules and case names as Prod–Phase 1 — mark Passed / Failed like UAT execute.
      </Notice>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-[12rem] flex-1">
          <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-xl border border-slate-200 bg-white pr-3 pl-9 text-sm dark:border-white/10 dark:bg-white/[0.04]"
            value={tester}
            onChange={(e) => changeTester(e.target.value)}
            placeholder="Tester name"
          />
        </label>
        {counts && (
          <Badge tone="brand">
            {counts.executed}/{counts.total} · {counts.passed} passed · {counts.failed} failed · {counts.remaining} left
          </Badge>
        )}
      </div>

      {moduleRows.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setModuleTab("all")}
            className={clsx(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition",
              moduleTab === "all"
                ? "bg-slate-900 text-white dark:bg-white dark:text-zinc-900"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-zinc-300",
            )}
          >
            All modules ({session.cases.length})
          </button>
          {moduleRows.map((m) => (
            <button
              key={m.module}
              type="button"
              onClick={() => setModuleTab(m.module)}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                moduleTab === m.module
                  ? "bg-slate-900 text-white dark:bg-white dark:text-zinc-900"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-zinc-300",
              )}
            >
              {m.module} ({m.count})
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={clsx(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition",
              filter === f.id
                ? "bg-brand-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/[0.06] dark:text-zinc-300",
            )}
          >
            {f.label}
          </button>
        ))}
        <label className="relative ml-auto min-w-[10rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-9 w-full rounded-lg border border-slate-200 bg-white pr-3 pl-9 text-sm dark:border-white/10 dark:bg-white/[0.04]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cases"
          />
        </label>
      </div>

      <Section title="Cases" description={`${visible.length.toLocaleString()} shown · Spira modules on ${session.device === "iOS" ? "iOS" : "Android"}`}>
        {visible.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-zinc-500">No cases in this filter.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {visible.map((card) => {
              const result = resultMap.get(card.key);
              const open = openKey === card.key;
              return (
                <li key={card.key} className="py-3">
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 text-left"
                    onClick={() => {
                      setOpenKey(open ? null : card.key);
                      setComment(result?.comment ?? "");
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900 dark:text-white">{card.name}</span>
                        <StatusChip status={result?.status ?? null} />
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-500">
                        TC{card.testCaseId} · {card.module} · {card.testSetName}
                      </p>
                    </div>
                  </button>
                  {open && (
                    <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                      <textarea
                        className="min-h-[4.5rem] w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-white/10 dark:bg-zinc-950"
                        placeholder={`Notes for ${environmentLabel(session.device, session.network)} (optional)`}
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                      />
                      <div className="flex flex-wrap gap-2">
                        {EXECUTION_STATUSES.map((status) => (
                          <button
                            key={status}
                            type="button"
                            onClick={() => mark(card, status)}
                            className={clsx(
                              "rounded-lg px-3 py-1.5 text-xs font-semibold ring-2 ring-offset-1 ring-offset-transparent transition",
                              STATUS_STYLE[status].button,
                            )}
                          >
                            {STATUS_LABEL[status]}
                          </button>
                        ))}
                        {result && (
                          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => clear(card)}>
                            Clear
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
