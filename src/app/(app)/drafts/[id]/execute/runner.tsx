"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSettings } from "@/components/settings-context";
import { Button, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { recordResults, saveProgress, undoRun } from "@/lib/client/execution";
import { relativeTime } from "@/lib/client/format";
import { readTestCase } from "@/lib/client/test-cases";
import {
  currentStatus,
  emptyProgress,
  executedSteps,
  missingForSave,
  progressStatus,
  runnableSteps,
  STATUS_LABEL,
} from "@/lib/domain/execution";
import {
  EXECUTION_STATUSES,
  STEP_STATUSES,
  type Card,
  type Draft,
  type ExecutionProgress,
  type ExecutionStatus,
  type StepStatus,
  type TestCaseDetail,
} from "@/lib/domain/types";

export const STATUS_STYLE: Record<StepStatus | "notRun", { chip: string; button: string; key: string }> = {
  passed: {
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
    button: "bg-emerald-600 text-white ring-emerald-600",
    key: "P",
  },
  failed: {
    chip: "bg-red-50 text-red-700 ring-red-200/70 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20",
    button: "bg-red-600 text-white ring-red-600",
    key: "F",
  },
  blocked: {
    chip: "bg-orange-50 text-orange-700 ring-orange-200/70 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20",
    button: "bg-orange-500 text-white ring-orange-500",
    key: "B",
  },
  caution: {
    chip: "bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
    button: "bg-amber-500 text-white ring-amber-500",
    key: "C",
  },
  notApplicable: {
    chip: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10",
    button: "bg-slate-500 text-white ring-slate-500",
    key: "N",
  },
  notRun: {
    chip: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10",
    button: "",
    key: "",
  },
};

const KEY_TO_STATUS: Record<string, StepStatus> = { p: "passed", f: "failed", b: "blocked", c: "caution", n: "notApplicable" };

export function StatusChip({ status, className }: { status: StepStatus | null; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_STYLE[status ?? "notRun"].chip, className)}>
      {status ? STATUS_LABEL[status] : "Not Run"}
    </span>
  );
}

type Loaded = { testCaseId: number; detail: TestCaseDetail | null; error: string | null };

/**
 * Runs one In Scope case: its steps from Spira, a result per step (or one for the whole case),
 * and saving the result to Spira as a test run. Marks are kept in the draft as they are made.
 */
export function Runner({
  card,
  draft,
  tester,
  position,
  onClose,
  onPrev,
  onNext,
  onChange,
}: {
  card: Card | null;
  draft: Draft;
  tester: string;
  position: { index: number; total: number } | null;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onChange: (draft: Draft) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = card !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="runner-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-auto h-[min(60rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-lift dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {card && (
        <Content
          key={card.key}
          card={card}
          draft={draft}
          tester={tester}
          position={position}
          onClose={onClose}
          onPrev={onPrev}
          onNext={onNext}
          onChange={onChange}
        />
      )}
    </dialog>
  );
}

function Content({
  card,
  draft,
  tester,
  position,
  onClose,
  onPrev,
  onNext,
  onChange,
}: {
  card: Card;
  draft: Draft;
  tester: string;
  position: { index: number; total: number } | null;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onChange: (draft: Draft) => void;
}) {
  const { spira } = useSettings();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<ExecutionProgress>(() => draft.execution?.progress[card.key] ?? emptyProgress());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<number | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<number | null>(null);
  const actualRefs = useRef(new Map<string, HTMLTextAreaElement>());

  useEffect(() => {
    let active = true;
    readTestCase(draft.projectId, card.testCaseId, attempt > 0).then(
      (detail) => active && setLoaded({ testCaseId: card.testCaseId, detail, error: null }),
      (err) => active && setLoaded({ testCaseId: card.testCaseId, detail: null, error: errorMessage(err) }),
    );
    return () => {
      active = false;
    };
  }, [draft.projectId, card.testCaseId, attempt]);

  const detail = loaded?.detail ?? null;
  const steps = useMemo(() => (detail ? runnableSteps(detail.steps) : []), [detail]);
  const status = progressStatus(progress, steps);
  const sent = executedSteps(progress, steps);
  const blocker = missingForSave(status, progress.comment, sent);
  const current = steps.findIndex((s) => !progress.steps[s.label]?.status);
  const stopped = steps.some((s) => {
    const st = progress.steps[s.label]?.status;
    return st === "failed" || st === "blocked";
  });
  const inSpira = currentStatus(card, draft.execution);
  const runs = (draft.execution?.runs ?? []).filter((r) => r.testSetId === card.testSetId && r.testSetTestCaseId === card.testSetTestCaseId).reverse();
  const setName = draft.testSets.find((s) => s.testSetId === card.testSetId)?.testSetName ?? `TX${card.testSetId}`;
  const spiraLink = spira?.siteUrl ? `${spira.siteUrl}/${draft.projectId}/TestCase/${card.testCaseId}.aspx` : null;

  const pending = useRef<{ next: ExecutionProgress; timer: ReturnType<typeof setTimeout> } | null>(null);
  const persist = useRef<(next: ExecutionProgress) => void>(() => {});
  useEffect(() => {
    persist.current = (next) => {
      const empty = !next.comment && !next.status && Object.values(next.steps).every((s) => !s.status && !s.actualResult);
      onChange(saveProgress(draft.id, card.key, empty ? null : next));
    };
  }, [draft.id, card.key, onChange]);
  const flush = () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    const { next } = pending.current;
    pending.current = null;
    persist.current(next);
  };
  const discardPending = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };
  useEffect(() => flush, []);

  /** Marks are saved to the draft shortly after the last change, so typing does not rewrite storage on every key. */
  const update = (next: ExecutionProgress) => {
    setProgress(next);
    setError(null);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { next, timer: setTimeout(flush, 400) };
  };

  const markStep = (label: string, value: StepStatus | null) => {
    const prev = progress.steps[label] ?? { status: null, actualResult: "" };
    update({ ...progress, steps: { ...progress.steps, [label]: { ...prev, status: prev.status === value ? null : value } } });
    if (value && value !== "passed" && value !== "notApplicable" && prev.status !== value) {
      requestAnimationFrame(() => actualRefs.current.get(label)?.focus());
    }
  };

  const passRemaining = () =>
    update({
      ...progress,
      steps: Object.fromEntries(
        steps.map((s) => [s.label, progress.steps[s.label]?.status ? progress.steps[s.label] : { status: "passed" as const, actualResult: progress.steps[s.label]?.actualResult ?? "" }]),
      ),
    });

  async function save(andNext: boolean) {
    if (!status || blocker) return;
    flush();
    setSaving(true);
    setError(null);
    try {
      const out = await recordResults(
        draft.id,
        card.testSetId,
        [{ testCaseId: card.testCaseId, testSetTestCaseId: card.testSetTestCaseId, status, comment: progress.comment.trim(), steps: sent }],
        tester,
      );
      onChange(out.draft);
      const r = out.results[0];
      if (r?.result !== "recorded") {
        setError(r?.message ?? "Spira did not record this result.");
        return;
      }
      discardPending();
      setProgress(emptyProgress());
      if (andNext && onNext) onNext();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function undo(testRunId: number) {
    const run = runs.find((r) => r.testRunId === testRunId);
    if (!run) return;
    setConfirmUndo(null);
    setUndoing(testRunId);
    setError(null);
    try {
      onChange(await undoRun(draft.id, run));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUndoing(null);
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save(true);
      return;
    }
    if ((e.target as HTMLElement).closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    const value = KEY_TO_STATUS[e.key.toLowerCase()];
    if (value && steps.length > 0 && current >= 0) {
      e.preventDefault();
      markStep(steps[current].label, value);
    } else if (value && steps.length === 0 && detail && value !== "notApplicable") {
      e.preventDefault();
      update({ ...progress, status: progress.status === value ? null : (value as ExecutionStatus) });
    } else if (e.key === "ArrowLeft" && onPrev) {
      e.preventDefault();
      onPrev();
    } else if (e.key === "ArrowRight" && onNext) {
      e.preventDefault();
      onNext();
    }
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <header className="border-b border-slate-100 px-5 pt-4 pb-4 sm:px-6 dark:border-white/[0.06]">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-500 dark:text-zinc-400">In Spira</span>
            <StatusChip status={inSpira} />
            <span className="font-mono text-slate-500 dark:text-zinc-400">TC{card.testCaseId}</span>
            {card.tcId && <span className="font-mono text-slate-500 dark:text-zinc-400">· {card.tcId}</span>}
            <span className="truncate text-slate-500 dark:text-zinc-400">· {setName}</span>
          </div>
          <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-0.5">
            {position && (
              <>
                <IconButton label="Previous case (←)" onClick={onPrev} icon={<ChevronLeft className="size-4" />} />
                <span className="px-1 text-xs text-slate-500 tabular-nums dark:text-zinc-500">
                  {position.index + 1} / {position.total}
                </span>
                <IconButton label="Next case (→)" onClick={onNext} icon={<ChevronRight className="size-4" />} />
              </>
            )}
            <IconButton label="Close (Esc)" onClick={onClose} icon={<X className="size-4" />} />
          </div>
        </div>
        <h2 id="runner-title" className="mt-2.5 text-lg leading-snug font-semibold tracking-tight text-pretty">
          {card.name}
        </h2>
        {spiraLink && (
          <a href={spiraLink} target="_blank" rel="noreferrer noopener" className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
            Open in Spira <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </header>

      <div tabIndex={-1} autoFocus className="flex-1 overflow-y-auto px-5 py-5 outline-none sm:px-6">
        <div className="flex flex-col gap-6">
          {!loaded && <SkeletonLines lines={6} />}
          {loaded?.error && (
            <Notice
              tone="danger"
              title="Could not load this test case from Spira"
              action={<Button size="sm" icon={RefreshCw} onClick={() => { setLoaded(null); setAttempt((n) => n + 1); }}>Retry</Button>}
            >
              {loaded.error}
            </Notice>
          )}

          {detail?.description && (
            <section>
              <Heading>Description</Heading>
              <div className="well px-3 py-2.5"><Text>{detail.description}</Text></div>
            </section>
          )}

          {detail && steps.length > 0 && (
            <section>
              <Heading
                aside={
                  <span className="flex items-center gap-3 text-xs text-slate-500 dark:text-zinc-400">
                    <span className="tabular-nums">{steps.filter((s) => progress.steps[s.label]?.status).length} / {steps.length} marked</span>
                    {current >= 0 && !stopped && (
                      <button type="button" className="cursor-pointer font-medium text-emerald-700 hover:underline dark:text-emerald-300" onClick={passRemaining}>
                        Pass remaining steps
                      </button>
                    )}
                  </span>
                }
              >
                Test steps
              </Heading>
              <ol className="flex flex-col gap-2.5">
                {steps.map(({ label, linkedFrom, step }, i) => {
                  const mark = progress.steps[label];
                  const needsActual = mark?.status && mark.status !== "passed" && mark.status !== "notApplicable";
                  return (
                    <li
                      key={label}
                      className={clsx(
                        "flex gap-3 rounded-xl border px-4 py-3.5 transition-colors",
                        i === current ? "border-brand-300 ring-1 ring-brand-200 dark:border-brand-400/40 dark:ring-brand-400/20" : "border-slate-200/80 dark:border-white/[0.07]",
                        mark?.status === "passed" && "bg-emerald-50/40 dark:bg-emerald-500/[0.04]",
                      )}
                    >
                      <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-600 tabular-nums dark:bg-white/[0.07] dark:text-zinc-300">
                        {label}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-3">
                        {linkedFrom && <p className="text-xs text-slate-500 dark:text-zinc-400">From linked test case {linkedFrom}</p>}
                        {step.precondition && <Labeled label="Precondition">{step.precondition}</Labeled>}
                        <Text>{step.description || (step.linkedTestCaseId ? `Calls TC${step.linkedTestCaseId}` : "No description.")}</Text>
                        {(step.expectedResult || step.sampleData) && (
                          <div className="grid gap-3 sm:grid-cols-2">
                            {step.expectedResult && <Labeled label="Expected result">{step.expectedResult}</Labeled>}
                            {step.sampleData && <Labeled label="Test data">{step.sampleData}</Labeled>}
                          </div>
                        )}
                        <StatusButtons options={STEP_STATUSES} value={mark?.status ?? null} onPick={(v) => markStep(label, v)} hints={i === current} />
                        {(needsActual || mark?.actualResult) && (
                          <textarea
                            ref={(el) => {
                              if (el) actualRefs.current.set(label, el);
                              else actualRefs.current.delete(label);
                            }}
                            className="input min-h-[4.5rem] text-sm"
                            placeholder="Actual result: what happened instead"
                            aria-label={`Actual result for step ${label}`}
                            value={mark?.actualResult ?? ""}
                            maxLength={4000}
                            onChange={(e) => update({ ...progress, steps: { ...progress.steps, [label]: { status: mark?.status ?? null, actualResult: e.target.value } } })}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {detail.truncated && <p className="mt-3 text-xs text-slate-500">Very long: only the first steps are shown. Open it in Spira to see the rest.</p>}
            </section>
          )}

          {detail && steps.length === 0 && (
            <section>
              <Heading>Result</Heading>
              <p className="mb-3 text-sm text-slate-600 dark:text-zinc-400">This test case has no steps in Spira. Record one result for the whole case.</p>
              <StatusButtons options={EXECUTION_STATUSES} value={progress.status} onPick={(v) => update({ ...progress, status: v === progress.status ? null : (v as ExecutionStatus) })} hints />
            </section>
          )}

          {detail && (
            <section>
              <Heading>Comment</Heading>
              <textarea
                className="input min-h-[4.5rem] text-sm"
                placeholder={status && status !== "passed" ? "What went wrong, defect ID, build or device used" : "Optional: build, device, anything worth noting"}
                aria-label="Comment"
                value={progress.comment}
                maxLength={4000}
                onChange={(e) => update({ ...progress, comment: e.target.value })}
              />
            </section>
          )}

          {runs.length > 0 && (
            <section>
              <Heading>Recorded here</Heading>
              <ul className="flex flex-col divide-y divide-slate-100 rounded-xl border border-slate-200/80 text-sm dark:divide-white/[0.06] dark:border-white/[0.07]">
                {runs.map((r) => (
                  <li key={r.testRunId} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <StatusChip status={r.status} />
                    <span className="text-slate-600 dark:text-zinc-400">
                      {relativeTime(r.at)}
                      {r.tester && ` by ${r.tester}`} · run {r.testRunId}
                    </span>
                    {r.comment && <span className="w-full truncate text-xs text-slate-500" title={r.comment}>{r.comment}</span>}
                    <span className="ml-auto flex items-center gap-2">
                      {confirmUndo === r.testRunId ? (
                        <>
                          <span className="text-xs text-slate-500">Delete this run from Spira?</span>
                          <Button size="sm" variant="danger" onClick={() => void undo(r.testRunId)}>Delete run</Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirmUndo(null)}>Keep</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="ghost" icon={RotateCcw} busy={undoing === r.testRunId} disabled={undoing !== null} onClick={() => setConfirmUndo(r.testRunId)}>
                          Undo
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      <footer className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 sm:px-6 dark:border-white/[0.06] dark:bg-white/[0.02]">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">Result</span>
          <StatusChip status={status} />
          {blocker && status && <span className="text-xs text-amber-700 dark:text-amber-300">{blocker}</span>}
          {!status && detail && <span className="text-xs text-slate-500">{steps.length ? "Mark the steps as you go." : "Pick a result."}</span>}
          <span className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-slate-500 lg:inline dark:text-zinc-500">
              <kbd className="kbd">P</kbd> <kbd className="kbd">F</kbd> <kbd className="kbd">B</kbd> <kbd className="kbd">C</kbd> mark · <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> save
            </span>
            <Button onClick={() => void save(false)} disabled={!status || !!blocker || saving}>Save</Button>
            <Button variant="primary" onClick={() => void save(true)} disabled={!status || !!blocker || saving} busy={saving}>
              {onNext ? "Save & next" : "Save to Spira"}
            </Button>
          </span>
        </div>
      </footer>
    </div>
  );
}

function StatusButtons({
  options,
  value,
  onPick,
  hints,
}: {
  options: readonly StepStatus[];
  value: StepStatus | null;
  onPick: (value: StepStatus) => void;
  hints?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Result">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onPick(option)}
          className={clsx(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition",
            value === option ? STATUS_STYLE[option].button : clsx(STATUS_STYLE[option].chip, "hover:brightness-95"),
          )}
        >
          {STATUS_LABEL[option]}
          {hints && <kbd className="text-[10px] opacity-60">{STATUS_STYLE[option].key}</kbd>}
        </button>
      ))}
    </div>
  );
}

function IconButton({ label, onClick, icon }: { label: string; onClick: (() => void) | null; icon: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!onClick}
      onClick={onClick ?? undefined}
      className="grid size-8 cursor-pointer place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white"
    >
      {icon}
    </button>
  );
}

function Heading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase dark:text-zinc-400">{children}</h3>
      {aside && <span className="ml-auto">{aside}</span>}
    </div>
  );
}

function Text({ children, className }: { children: string; className?: string }) {
  return <p className={clsx("text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800 dark:text-zinc-200", className)}>{children}</p>;
}

function Labeled({ label, children }: { label: string; children: string }) {
  return (
    <div className="well min-w-0 px-3 py-2">
      <p className="mb-0.5 text-[11px] font-medium text-slate-500 dark:text-zinc-500">{label}</p>
      <Text>{children}</Text>
    </div>
  );
}

function SkeletonLines({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${90 - ((i * 17) % 35)}%` }} />
      ))}
    </div>
  );
}
