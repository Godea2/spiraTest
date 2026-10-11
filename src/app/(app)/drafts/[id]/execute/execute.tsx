"use client";

import clsx from "clsx";
import { Check, ChevronLeft, ListChecks, Play, RefreshCw, Search, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, ButtonLink, Dialog, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { getDraft } from "@/lib/client/drafts";
import { getTester, recordResults, refreshExecution, setTester as storeTester, undoRun } from "@/lib/client/execution";
import { formatDateTime } from "@/lib/client/format";
import { useDraft } from "@/lib/client/use-draft";
import { isCompleted } from "@/lib/domain/board";
import { currentStatus, executionCards, executionCounts, STATUS_LABEL } from "@/lib/domain/execution";
import type { Card, Draft, ExecutionStatus } from "@/lib/domain/types";
import { Runner, StatusChip, STATUS_STYLE } from "./runner";

type Filter = "all" | "notRun" | "inProgress" | ExecutionStatus;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "notRun", label: "Not Run" },
  { id: "inProgress", label: "In progress" },
  { id: "passed", label: "Passed" },
  { id: "failed", label: "Failed" },
  { id: "blocked", label: "Blocked" },
  { id: "caution", label: "Caution" },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function Execute({ id }: { id: string }) {
  const { draft, setDraft, error: loadError } = useDraft(id);
  const [tester, setTester] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [setTab, setSetTab] = useState<number | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [sync, setSync] = useState<{ checking: boolean; errors: string[] }>({ checking: false, errors: [] });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const checkedOnOpen = useRef(false);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && setTester(getTester()));
    return () => {
      active = false;
    };
  }, []);

  const loaded = draft !== null;
  useEffect(() => {
    if (!loaded || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    void checkSpira();
    // Runs once when the draft is first available; later checks are on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const cards = useMemo(() => (draft ? executionCards(draft) : []), [draft]);
  const counts = useMemo(() => executionCounts(cards, draft?.execution), [cards, draft]);

  const visible = useMemo(() => {
    if (!draft) return [];
    const q = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (setTab !== "all" && card.testSetId !== setTab) return false;
      if (q && !`${card.name} TC${card.testCaseId} ${card.tcId ?? ""}`.toLowerCase().includes(q)) return false;
      if (filter === "all") return true;
      if (filter === "inProgress") return Boolean(draft.execution?.progress[card.key]);
      const status = currentStatus(card, draft.execution);
      return filter === "notRun" ? status === null : status === filter;
    });
  }, [cards, draft, filter, query, setTab]);

  if (loadError && !draft) {
    return <Notice tone="danger" title="This draft could not be opened" action={<ButtonLink href="/completed" size="sm">Back to Completed</ButtonLink>}>{loadError}</Notice>;
  }
  if (!draft) return <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading…</div>;

  const executed = counts.total - counts.notRun;
  const openIndex = openKey ? visible.findIndex((c) => c.key === openKey) : -1;
  const openCard = openKey ? (cards.find((c) => c.key === openKey) ?? null) : null;
  const visibleSelected = visible.filter((c) => selected.has(c.key));
  const allVisibleSelected = visible.length > 0 && visibleSelected.length === visible.length;
  const setName = (testSetId: number) => draft.testSets.find((s) => s.testSetId === testSetId)?.testSetName ?? `TX${testSetId}`;
  const releaseText = draft.releaseLabel || draft.releaseId;

  async function checkSpira() {
    setSync({ checking: true, errors: [] });
    try {
      const out = await refreshExecution(id);
      setDraft(out.draft);
      setSync({ checking: false, errors: out.errors });
    } catch (err) {
      setSync({ checking: false, errors: [errorMessage(err)] });
    }
  }

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };

  const markBusy = (keys: string[], on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  async function quickPass(card: Card) {
    markBusy([card.key], true);
    try {
      const out = await recordResults(id, card.testSetId, [{ testCaseId: card.testCaseId, testSetTestCaseId: card.testSetTestCaseId, status: "passed", comment: "", steps: [] }], tester.trim());
      setDraft(out.draft);
      const r = out.results[0];
      if (r?.result === "recorded" && r.testRunId) {
        const run = out.draft.execution?.runs.find((x) => x.testRunId === r.testRunId);
        toast.success(`TC${card.testCaseId} recorded as Passed`, {
          action: run ? { label: "Undo", onClick: () => void undoQuick(run.testRunId) } : undefined,
        });
      } else {
        toast.error(`TC${card.testCaseId}: ${r?.message ?? "not recorded"}`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      markBusy([card.key], false);
    }
  }

  async function undoQuick(testRunId: number) {
    const run = getDraft(id).execution?.runs.find((r) => r.testRunId === testRunId);
    if (!run) return;
    try {
      setDraft(await undoRun(id, run));
      toast.success(`Undone: run ${testRunId} deleted from Spira`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function bulkPass() {
    setConfirmBulk(false);
    setBulkRunning(true);
    const targets = visibleSelected;
    markBusy(targets.map((c) => c.key), true);
    let latest: Draft | null = null;
    let recorded = 0;
    const problems: string[] = [];
    try {
      const bySet = new Map<number, Card[]>();
      for (const c of targets) bySet.set(c.testSetId, [...(bySet.get(c.testSetId) ?? []), c]);
      for (const [testSetId, group] of bySet) {
        const out = await recordResults(
          id,
          testSetId,
          group.map((c) => ({ testCaseId: c.testCaseId, testSetTestCaseId: c.testSetTestCaseId, status: "passed" as const, comment: "", steps: [] })),
          tester.trim(),
        );
        latest = out.draft;
        recorded += out.results.filter((r) => r.result === "recorded").length;
        problems.push(...out.results.filter((r) => r.result !== "recorded").map((r) => `TC${r.testCaseId}: ${r.message ?? r.result}`));
      }
    } catch (err) {
      problems.push(errorMessage(err));
    } finally {
      if (latest) setDraft(latest);
      markBusy(targets.map((c) => c.key), false);
      setBulkRunning(false);
      setSelected(new Set());
    }
    if (recorded) toast.success(`Recorded ${plural(recorded, "Passed result")} in Spira`);
    if (problems.length) toast.error(`${plural(problems.length, "case")} not recorded: ${problems[0]}`);
  }

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={isCompleted(draft.status) ? "/completed" : "/drafts"} className="inline-flex items-center gap-1 transition hover:text-slate-900 dark:hover:text-white">
              <ChevronLeft className="size-4" aria-hidden /> {isCompleted(draft.status) ? "Completed" : "Drafts"}
            </Link>
            <span className="text-slate-300 dark:text-zinc-700">/</span>
            {draft.module}
            {releaseText ? <span className="text-slate-400 dark:text-zinc-500">· Release {releaseText}</span> : null}
          </span>
        }
        title={`Execute: ${draft.name}`}
        description="Run the In Scope cases. Open a case to go step by step, or pass it in one click. Each result is recorded in Spira as a test run as soon as you save it, and can be undone."
        actions={
          <>
            <ButtonLink href={`/drafts/${draft.id}`} variant="ghost">Board</ButtonLink>
            <Button icon={RefreshCw} onClick={() => void checkSpira()} busy={sync.checking}>Check Spira again</Button>
          </>
        }
      />

      {!isCompleted(draft.status) && (
        <Notice tone="warning" title="This draft is not completed yet">
          Finish the review and live apply first, so the In Scope list here matches the test sets in Spira.
        </Notice>
      )}
      {sync.errors.length > 0 && (
        <Notice tone="warning" title="Spira could not be read">
          <ul className="list-disc pl-5">{sync.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </Notice>
      )}

      <Section>
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm text-slate-500 dark:text-zinc-400">Executed</p>
              <p className="text-3xl font-semibold tracking-tight tabular-nums">
                {executed} <span className="text-lg font-normal text-slate-400">/ {counts.total}</span>
              </p>
            </div>
            <label className="flex min-w-[16rem] flex-col gap-1 text-sm">
              <span className="flex items-center gap-1.5 font-medium"><UserRound className="size-4 text-slate-400" aria-hidden /> Tester</span>
              <input className="input" placeholder="Your name, written on each run" value={tester} maxLength={100} onChange={(e) => changeTester(e.target.value)} />
            </label>
          </div>
          <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]" aria-hidden>
            {(["passed", "caution", "blocked", "failed"] as const).map((s) =>
              counts[s] > 0 ? <span key={s} className={clsx(STATUS_STYLE[s].button, "ring-0")} style={{ width: `${(counts[s] / Math.max(1, counts.total)) * 100}%` }} /> : null,
            )}
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(["passed", "failed", "blocked", "caution"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setFilter(filter === s ? "all" : s)} className={clsx("rounded-xl px-3 py-2 text-left ring-1 ring-inset transition", filter === s ? STATUS_STYLE[s].chip : "ring-slate-200 hover:bg-slate-50 dark:ring-white/10 dark:hover:bg-white/[0.03]")}>
                <dt className="text-xs text-slate-500 dark:text-zinc-400">{STATUS_LABEL[s]}</dt>
                <dd className="text-xl font-semibold tabular-nums">{counts[s]}</dd>
              </button>
            ))}
            <button type="button" onClick={() => setFilter(filter === "notRun" ? "all" : "notRun")} className={clsx("rounded-xl px-3 py-2 text-left ring-1 ring-inset transition", filter === "notRun" ? STATUS_STYLE.notRun.chip : "ring-slate-200 hover:bg-slate-50 dark:ring-white/10 dark:hover:bg-white/[0.03]")}>
              <dt className="text-xs text-slate-500 dark:text-zinc-400">Not Run</dt>
              <dd className="text-xl font-semibold tabular-nums">{counts.notRun}</dd>
            </button>
          </dl>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            {sync.checking ? (
              <span className="inline-flex items-center gap-1.5"><Spinner className="size-3" /> Reading the latest results from Spira…</span>
            ) : draft.execution?.checkedAt ? (
              `Statuses read from Spira at ${formatDateTime(draft.execution.checkedAt)}. Results recorded by others in Spira show up here after a check.`
            ) : (
              "Statuses are from the comparison until Spira is checked."
            )}
          </p>
          {executed === counts.total && counts.total > 0 && (
            <Notice tone="success" title="Every In Scope case has a result">
              {counts.failed + counts.blocked + counts.caution === 0 ? "All passed." : `${counts.failed} failed, ${counts.blocked} blocked and ${counts.caution} with caution; open them to re-test after fixes.`}
            </Notice>
          )}
        </div>
      </Section>

      <Section icon={ListChecks} title="In Scope cases" description={`${plural(counts.total, "case")} from ${plural(draft.testSets.length, "test set")}${releaseText ? `, recorded against release ${releaseText}` : ""}.`}>
        <div className="mb-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <input type="search" className="input pl-9" placeholder="Search by name or TC" aria-label="Search cases" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {draft.testSets.length > 1 && (
              <select className="input w-auto" aria-label="Test set" value={String(setTab)} onChange={(e) => setSetTab(e.target.value === "all" ? "all" : Number(e.target.value))}>
                <option value="all">All test sets</option>
                {draft.testSets.map((s) => <option key={s.testSetId} value={s.testSetId}>{s.testSetName}</option>)}
              </select>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by result">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={clsx(
                  "cursor-pointer rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition",
                  filter === f.id ? "bg-slate-900 text-white ring-slate-900 dark:bg-white dark:text-zinc-900 dark:ring-white" : "text-slate-600 ring-slate-200 hover:bg-slate-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/[0.04]",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {visible.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-white/[0.03]">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-brand-600"
                checked={allVisibleSelected}
                onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((c) => c.key)))}
              />
              {visibleSelected.length ? `${visibleSelected.length} selected` : `Select all ${visible.length}`}
            </label>
            {visibleSelected.length > 0 && (
              <Button size="sm" icon={Check} onClick={() => setConfirmBulk(true)} busy={bulkRunning} disabled={bulkRunning}>
                Mark {visibleSelected.length} Passed
              </Button>
            )}
          </div>
        )}

        {visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">{cards.length === 0 ? "This draft has no In Scope cases." : "No cases match these filters."}</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {visible.map((card) => {
              const status = currentStatus(card, draft.execution);
              const lastRun = [...(draft.execution?.runs ?? [])].reverse().find((r) => r.testSetId === card.testSetId && r.testSetTestCaseId === card.testSetTestCaseId);
              const inProgress = Boolean(draft.execution?.progress[card.key]);
              const working = busy.has(card.key);
              return (
                <li key={card.key} className="flex items-center gap-3 py-2.5">
                  <input type="checkbox" className="size-4 shrink-0 accent-brand-600" aria-label={`Select TC${card.testCaseId}`} checked={selected.has(card.key)} onChange={() => toggle(card.key)} />
                  <button type="button" className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left" onClick={() => setOpenKey(card.key)}>
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-slate-500">TC{card.testCaseId}</span>
                      <span className="truncate text-sm font-medium hover:text-brand-700 dark:hover:text-brand-300">{card.name}</span>
                    </span>
                    {(lastRun || draft.testSets.length > 1) && (
                      <span className="mt-0.5 truncate text-xs text-slate-500 dark:text-zinc-500">
                        {draft.testSets.length > 1 && setName(card.testSetId)}
                        {draft.testSets.length > 1 && lastRun && " · "}
                        {lastRun && `${STATUS_LABEL[lastRun.status]} here ${formatDateTime(lastRun.at)}${lastRun.tester ? ` by ${lastRun.tester}` : ""}`}
                      </span>
                    )}
                  </button>
                  {inProgress && <Badge tone="brand">In progress</Badge>}
                  <StatusChip status={status} className="shrink-0" />
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" icon={Check} title="Record Passed for the whole case" aria-label={`Pass TC${card.testCaseId}`} onClick={() => void quickPass(card)} busy={working} disabled={working || bulkRunning}>
                      <span className="hidden sm:inline">Pass</span>
                    </Button>
                    <Button size="sm" variant="secondary" icon={Play} onClick={() => setOpenKey(card.key)} disabled={working}>
                      Run
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Runner
        card={openCard}
        draft={draft}
        tester={tester.trim()}
        position={openIndex >= 0 ? { index: openIndex, total: visible.length } : null}
        onClose={() => setOpenKey(null)}
        onPrev={openIndex > 0 ? () => setOpenKey(visible[openIndex - 1].key) : null}
        onNext={openIndex >= 0 && openIndex < visible.length - 1 ? () => setOpenKey(visible[openIndex + 1].key) : null}
        onChange={setDraft}
      />

      <Dialog
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        title={`Record Passed for ${plural(visibleSelected.length, "case")}?`}
        footer={
          <>
            <Button onClick={() => setConfirmBulk(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void bulkPass()}>Record Passed</Button>
          </>
        }
      >
        <p>
          Each selected case gets a Passed test run in Spira with every step marked Passed{tester.trim() ? `, recorded as tested by ${tester.trim()}` : ""}.
          Only do this for cases that were actually tested. Each run can be undone from the case.
        </p>
      </Dialog>
    </div>
  );
}
