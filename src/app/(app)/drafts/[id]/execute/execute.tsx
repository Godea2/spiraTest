"use client";

import clsx from "clsx";
import { Check, ChevronLeft, Download, ListChecks, Play, RefreshCw, Search, Square, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Dialog, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { getDraft } from "@/lib/client/drafts";
import { getTester, recordResults, refreshExecution, setTester as storeTester, undoRun } from "@/lib/client/execution";
import { formatDateTime } from "@/lib/client/format";
import { useDraft } from "@/lib/client/use-draft";
import { exportExecution } from "@/lib/client/exports";
import { cardKey, isCompleted } from "@/lib/domain/board";
import { confirmInSpira, currentStatus, executionCards, executionCounts, MAX_EXECUTION_BATCH, STATUS_LABEL } from "@/lib/domain/execution";
import { EXECUTION_STATUSES, type Card, type ExecutionResult, type ExecutionStatus } from "@/lib/domain/types";
import { Runner, StatusButtons, StatusChip, STATUS_STYLE } from "./runner";

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

interface BulkReport {
  status: ExecutionStatus;
  comment: string;
  total: number;
  recorded: number;
  /** How many Spira shows with the recorded status after a fresh read; null when it could not be read. */
  confirmed: number | null;
  differing: number;
  failed: Array<{ key: string; testCaseId: number; message: string }>;
  stopped: boolean;
  seconds: number;
}

export function Execute({ id }: { id: string }) {
  const { draft, setDraft, error: loadError } = useDraft(id);
  const { spira } = useSettings();
  const [tester, setTester] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [setTab, setSetTab] = useState<number | "all">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Cases of a "Run all" session, fixed when it starts so saving a case does not reorder the run. */
  const [queue, setQueue] = useState<{ keys: string[]; runsBefore: number } | null>(null);
  const [sync, setSync] = useState<{ checking: boolean; errors: string[] }>({ checking: false, errors: [] });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ status: ExecutionStatus; comment: string } | null>(null);
  const [job, setJob] = useState<{ status: ExecutionStatus; total: number; done: number; stopping: boolean; checking: boolean } | null>(null);
  const [report, setReport] = useState<BulkReport | null>(null);
  const stopRef = useRef(false);
  const bulkRunning = job !== null;
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
  const nav = queue ? queue.keys.flatMap((key) => cards.filter((c) => c.key === key)) : visible;
  const openIndex = openKey ? nav.findIndex((c) => c.key === openKey) : -1;
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

  /**
   * Records one result, with one reason, for many cases: batches of cases per request, live progress,
   * a stop between batches, then a fresh read of Spira to confirm what it now shows.
   */
  async function bulkRecord(status: ExecutionStatus, comment: string, targets: Card[]) {
    if (targets.length === 0) return;
    setBulk(null);
    setReport(null);
    stopRef.current = false;
    const started = Date.now();
    setJob({ status, total: targets.length, done: 0, stopping: false, checking: false });
    markBusy(targets.map((c) => c.key), true);
    const results: ExecutionResult[] = [];
    const failed: BulkReport["failed"] = [];
    try {
      const bySet = new Map<number, Card[]>();
      for (const c of targets) bySet.set(c.testSetId, [...(bySet.get(c.testSetId) ?? []), c]);
      for (const [testSetId, group] of bySet) {
        if (stopRef.current) break;
        const before = results.length;
        try {
          const out = await recordResults(
            id,
            testSetId,
            group.map((c) => ({ testCaseId: c.testCaseId, testSetTestCaseId: c.testSetTestCaseId, status, comment: comment.trim(), steps: [] })),
            tester.trim(),
            {
              keepGoing: () => !stopRef.current,
              onBatch: (done, d) => {
                setDraft(d);
                setJob((j) => (j ? { ...j, done: before + done } : j));
              },
            },
          );
          results.push(...out.results);
        } catch (err) {
          const sent = new Set(results.map((r) => cardKey(r.testSetId, r.testSetTestCaseId)));
          for (const c of group) if (!sent.has(c.key)) failed.push({ key: c.key, testCaseId: c.testCaseId, message: errorMessage(err) });
        }
      }
      for (const r of results) {
        if (r.result !== "recorded") failed.push({ key: cardKey(r.testSetId, r.testSetTestCaseId), testCaseId: r.testCaseId, message: r.message ?? r.result });
      }
      const recorded = results.filter((r) => r.result === "recorded").length;
      let confirmed: number | null = null;
      let differing = 0;
      if (recorded > 0) {
        setJob((j) => (j ? { ...j, checking: true } : j));
        try {
          const sets = [...new Set(results.map((r) => r.testSetId))];
          const out = await refreshExecution(id, sets);
          setDraft(out.draft);
          if (out.errors.length === 0) {
            const check = confirmInSpira(results, out.draft.execution);
            confirmed = check.confirmed;
            differing = check.differing.length;
          }
        } catch {
          // The confirmation is a courtesy read; the results are recorded either way.
        }
      }
      setReport({
        status,
        comment,
        total: targets.length,
        recorded,
        confirmed,
        differing,
        failed,
        stopped: stopRef.current && results.length + failed.length < targets.length,
        seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
      });
    } finally {
      markBusy(targets.map((c) => c.key), false);
      setJob(null);
      setSelected(new Set());
    }
  }

  function stopJob() {
    stopRef.current = true;
    setJob((j) => (j ? { ...j, stopping: true } : j));
  }

  /** Runs the selected cases, or every listed case, one after another; picks up at the first one not finished. */
  function runAll() {
    const targets = visibleSelected.length ? visibleSelected : visible;
    if (targets.length === 0) return;
    const start = targets.find((c) => draft!.execution?.progress[c.key] || currentStatus(c, draft!.execution) === null) ?? targets[0];
    setQueue({ keys: targets.map((c) => c.key), runsBefore: draft!.execution?.runs.length ?? 0 });
    setSelected(new Set());
    setOpenKey(start.key);
  }

  function closeRunner() {
    setOpenKey(null);
    setQueue(null);
  }

  function finishRun() {
    const recorded = (getDraft(id).execution?.runs.length ?? 0) - (queue?.runsBefore ?? 0);
    closeRunner();
    toast.success(recorded > 0 ? `Run finished: ${plural(recorded, "result")} recorded in Spira` : "Run finished");
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
            <Button icon={Download} onClick={() => void exportExecution(draft, spira?.siteUrl ?? null)}>Report</Button>
            <Button icon={RefreshCw} onClick={() => void checkSpira()} busy={sync.checking}>Check Spira again</Button>
          </>
        }
      />

      {job && (
        <Notice
          tone="info"
          title={
            job.checking
              ? "Confirming the results in Spira…"
              : `Recording ${STATUS_LABEL[job.status]}: ${job.done} of ${job.total}${job.stopping ? " (stopping after this batch)" : ""}`
          }
          action={!job.checking && <Button size="sm" icon={Square} onClick={stopJob} disabled={job.stopping}>Stop</Button>}
        >
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/[0.08]" aria-hidden>
            <div className={clsx("h-full transition-all duration-500", STATUS_STYLE[job.status].button)} style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} />
          </div>
          <p className="mt-1.5 text-xs">Each case gets a manual run in Spira{job.status === "passed" ? " with every step Passed" : ""}, {MAX_EXECUTION_BATCH} cases per request. You can keep this page open while it runs.</p>
        </Notice>
      )}

      {report && !job && (
        <Notice
          tone={report.failed.length || report.differing ? "warning" : "success"}
          title={`${plural(report.recorded, "case")} recorded as ${STATUS_LABEL[report.status]} in ${report.seconds}s${report.stopped ? " (stopped)" : ""}`}
          action={<Button size="sm" variant="ghost" onClick={() => setReport(null)}>Dismiss</Button>}
        >
          <ul className="flex flex-col gap-1">
            {report.confirmed !== null && report.recorded > 0 && (
              <li>
                Spira now shows {report.confirmed} of {report.recorded} as {STATUS_LABEL[report.status]}
                {report.differing ? `; ${report.differing} show a different result, most likely from a newer run` : ", confirmed by reading Spira again"}.
              </li>
            )}
            {report.confirmed === null && report.recorded > 0 && <li>Spira could not be read back to confirm; use Check Spira again.</li>}
            {report.stopped && <li>{report.total - report.recorded - report.failed.length} were not sent because you stopped.</li>}
            {report.failed.length > 0 && (
              <li>
                {plural(report.failed.length, "case")} not recorded:
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {report.failed.slice(0, 8).map((f) => <li key={f.key}>TC{f.testCaseId}: {f.message}</li>)}
                  {report.failed.length > 8 && <li>and {report.failed.length - 8} more</li>}
                </ul>
              </li>
            )}
          </ul>
          {report.failed.length > 0 && (
            <Button
              size="sm"
              className="mt-2"
              icon={RefreshCw}
              onClick={() => void bulkRecord(report.status, report.comment, cards.filter((c) => report.failed.some((f) => f.key === c.key)))}
            >
              Retry {plural(report.failed.length, "failed case")}
            </Button>
          )}
        </Notice>
      )}

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
            <Button
              size="sm"
              variant="primary"
              icon={Play}
              onClick={runAll}
              disabled={bulkRunning}
              title="Open the cases one after another, step by step; Save & next moves on"
            >
              {visibleSelected.length ? `Run ${visibleSelected.length} selected` : `Run all ${visible.length}`}
            </Button>
            {visibleSelected.length > 0 && (
              <Button size="sm" icon={Check} onClick={() => setBulk({ status: "passed", comment: "" })} busy={bulkRunning} disabled={bulkRunning}>
                Mark {visibleSelected.length} as…
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
        position={openIndex >= 0 ? { index: openIndex, total: nav.length } : null}
        onClose={closeRunner}
        onPrev={openIndex > 0 ? () => setOpenKey(nav[openIndex - 1].key) : null}
        onNext={openIndex >= 0 && openIndex < nav.length - 1 ? () => setOpenKey(nav[openIndex + 1].key) : null}
        onFinish={queue ? finishRun : null}
        onChange={setDraft}
      />

      <Dialog
        open={bulk !== null}
        onClose={() => setBulk(null)}
        title={`Record a result for ${plural(visibleSelected.length, "case")}`}
        footer={
          bulk && (
            <>
              <Button onClick={() => setBulk(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={bulk.status !== "passed" && !bulk.comment.trim()}
                onClick={() => void bulkRecord(bulk.status, bulk.comment, visibleSelected)}
              >
                Record {visibleSelected.length} {STATUS_LABEL[bulk.status]}
              </Button>
            </>
          )
        }
      >
        {bulk && (
          <div className="flex flex-col gap-4">
            <StatusButtons options={EXECUTION_STATUSES} value={bulk.status} onPick={(s) => setBulk({ ...bulk, status: s as ExecutionStatus })} />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">
                {bulk.status === "passed" ? "Comment (optional)" : `Why ${STATUS_LABEL[bulk.status].toLowerCase()}? (required)`}
              </span>
              <textarea
                className="input min-h-20"
                value={bulk.comment}
                maxLength={4000}
                placeholder={bulk.status === "blocked" ? "For example: feature not deployed to this build" : bulk.status === "passed" ? "" : "What happened"}
                onChange={(e) => setBulk({ ...bulk, comment: e.target.value })}
              />
            </label>
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              {bulk.status === "passed"
                ? "Each selected case gets a Passed test run in Spira with every step marked Passed"
                : `Each selected case gets a ${STATUS_LABEL[bulk.status]} test run in Spira: the first step is marked ${STATUS_LABEL[bulk.status]} with this reason, and the other steps stay Not Run`}
              {tester.trim() ? `, recorded as tested by ${tester.trim()}` : ""}. Only do this for cases that were actually tested; to record which step failed, use Run instead. Each run can be undone from the case.
            </p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
