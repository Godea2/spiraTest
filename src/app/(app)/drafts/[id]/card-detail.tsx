"use client";

import clsx from "clsx";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSettings } from "@/components/settings-context";
import { Button, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { readTestCase } from "@/lib/client/test-cases";
import { workbookRowsFor } from "@/lib/domain/matching";
import {
  COLUMN_LABELS,
  COLUMNS,
  type BlockedAssessment,
  type Card,
  type CellValue,
  type Column,
  type Draft,
  type TestCaseDetail,
  type TestCaseStep,
  type WorkbookRow,
} from "@/lib/domain/types";
import { COLUMN_STYLE } from "./board-parts";

const KEY_TO_COLUMN: Record<string, Column> = { "1": "inScope", "2": "blocked", "3": "outOfScope", "4": "needsReview" };
const LONG_FIELD = /step|data|expected|precondition|pre-condition|description|note|comment/i;
const MAX_WORKBOOK_ROWS = 5;

type Loaded = { testCaseId: number; detail: TestCaseDetail | null; error: string | null };

/**
 * Everything known about one card: where it sits and why, the not-implemented verdict, the workbook row it
 * matched, and the test case as stored in Spira (description, properties and steps, read on demand).
 */
export function CardDetail({
  card,
  draft,
  column,
  moved,
  keywords,
  assessment,
  position,
  onClose,
  onMove,
  onPrev,
  onNext,
}: {
  card: Card | null;
  draft: Draft;
  column: Column | null;
  moved: boolean;
  keywords: string[] | undefined;
  assessment: BlockedAssessment | null;
  position: { index: number; total: number } | null;
  onClose: () => void;
  onMove: (key: string, to: Column) => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = card !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (!card || (e.target as HTMLElement).closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowLeft" && onPrev) {
      e.preventDefault();
      onPrev();
    } else if (e.key === "ArrowRight" && onNext) {
      e.preventDefault();
      onNext();
    } else if (KEY_TO_COLUMN[e.key] && KEY_TO_COLUMN[e.key] !== column) {
      e.preventDefault();
      onMove(card.key, KEY_TO_COLUMN[e.key]);
    }
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="card-detail-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      className="m-auto h-[min(56rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-lift dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {card && column && (
        <Content
          key={card.key}
          card={card}
          draft={draft}
          column={column}
          moved={moved}
          keywords={keywords}
          assessment={assessment}
          position={position}
          onClose={onClose}
          onMove={onMove}
          onPrev={onPrev}
          onNext={onNext}
        />
      )}
    </dialog>
  );
}

function Content({
  card,
  draft,
  column,
  moved,
  keywords,
  assessment,
  position,
  onClose,
  onMove,
  onPrev,
  onNext,
}: {
  card: Card;
  draft: Draft;
  column: Column;
  moved: boolean;
  keywords: string[] | undefined;
  assessment: BlockedAssessment | null;
  position: { index: number; total: number } | null;
  onClose: () => void;
  onMove: (key: string, to: Column) => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const { spira } = useSettings();
  const style = COLUMN_STYLE[column];
  const ColumnIcon = style.icon;
  const setName = draft.testSets.find((s) => s.testSetId === card.testSetId)?.testSetName ?? `TX${card.testSetId}`;
  const rows = workbookRowsFor(card, draft.rows);
  const spiraLink = spira?.siteUrl ? `${spira.siteUrl}/${draft.projectId}/TestCase/${card.testCaseId}.aspx` : null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-100 px-5 pt-4 pb-4 sm:px-6 dark:border-white/[0.06]">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-xs">
            <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ring-inset", style.chip)}>
              <ColumnIcon className="size-3.5" aria-hidden />
              {COLUMN_LABELS[column]}
            </span>
            {moved && <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600 dark:bg-white/[0.06] dark:text-zinc-300">Moved manually</span>}
            {card.executed && (
              <span className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700 ring-1 ring-violet-200/70 ring-inset dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20">
                {card.executionStatus}
              </span>
            )}
            <span className="font-mono text-slate-500 dark:text-zinc-400">TC{card.testCaseId}</span>
            {card.tcId && <span className="font-mono text-slate-500 dark:text-zinc-400">· {card.tcId}</span>}
            <span className="truncate text-slate-500 dark:text-zinc-400">· {setName}</span>
          </div>
          <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-0.5">
            {position && (
              <>
                <IconButton label="Previous card (←)" onClick={onPrev} icon={<ChevronLeft className="size-4" />} />
                <span className="px-1 text-xs text-slate-500 tabular-nums dark:text-zinc-500">
                  {position.index + 1} / {position.total}
                </span>
                <IconButton label="Next card (→)" onClick={onNext} icon={<ChevronRight className="size-4" />} />
              </>
            )}
            <IconButton label="Close (Esc)" onClick={onClose} icon={<X className="size-4" />} />
          </div>
        </div>
        <h2 id="card-detail-title" className="mt-2.5 text-lg leading-snug font-semibold tracking-tight text-pretty">
          {card.name}
        </h2>
        {spiraLink && (
          <a
            href={spiraLink}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
          >
            Open in Spira <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </header>

      <div tabIndex={-1} autoFocus className="flex-1 overflow-y-auto px-5 py-5 outline-none sm:px-6">
        <div className="flex flex-col gap-7">
          <section>
            <Heading>Placement</Heading>
            <p className="text-sm leading-relaxed text-slate-700 dark:text-zinc-300">{card.reason}</p>
            {moved && (
              <p className="mt-1 text-xs text-slate-500 dark:text-zinc-500">
                Suggested {COLUMN_LABELS[card.suggestion]}; moved to {COLUMN_LABELS[column]} on this board.
              </p>
            )}
          </section>

          {(assessment || (keywords && keywords.length > 0)) && <Verdict assessment={assessment} keywords={keywords ?? []} />}

          <section>
            <Heading>From the workbook</Heading>
            {rows.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-zinc-500">No workbook row matches this test case.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {rows.slice(0, MAX_WORKBOOK_ROWS).map((row) => (
                  <WorkbookRowView key={`${row.sheet}:${row.rowNumber}`} row={row} />
                ))}
                {rows.length > MAX_WORKBOOK_ROWS && <p className="text-xs text-slate-500">…and {rows.length - MAX_WORKBOOK_ROWS} more rows.</p>}
              </div>
            )}
          </section>

          <SpiraSection projectId={draft.projectId} testCaseId={card.testCaseId} configured={spira?.configured ?? true} />
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 sm:px-6 dark:border-white/[0.06] dark:bg-white/[0.02]">
        <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">Move to</span>
        {COLUMNS.filter((c) => c !== column).map((to) => {
          const Icon = COLUMN_STYLE[to].icon;
          return (
            <button
              key={to}
              type="button"
              onClick={() => onMove(card.key, to)}
              className={clsx("inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition hover:brightness-95", COLUMN_STYLE[to].chip)}
              title={`Move to ${COLUMN_LABELS[to]} (${COLUMN_STYLE[to].key})`}
            >
              <Icon className="size-3.5" aria-hidden />
              {COLUMN_LABELS[to]}
            </button>
          );
        })}
        <span className="ml-auto hidden items-center gap-1 text-xs text-slate-500 sm:flex dark:text-zinc-500">
          <kbd className="kbd">←</kbd> <kbd className="kbd">→</kbd> browse · <kbd className="kbd">Esc</kbd> close
        </span>
      </footer>
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

function Verdict({ assessment, keywords }: { assessment: BlockedAssessment | null; keywords: string[] }) {
  const features = assessment?.features?.length ? assessment.features : keywords;
  const blocked = assessment?.blocked ?? true;
  return (
    <section>
      <Heading>Not-implemented check</Heading>
      <div
        className={clsx(
          "rounded-xl border px-4 py-3.5",
          !assessment
            ? "border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/[0.03]"
            : blocked
              ? "border-orange-200/80 bg-orange-50/60 dark:border-orange-400/20 dark:bg-orange-500/[0.06]"
              : "border-sky-200/80 bg-sky-50/60 dark:border-sky-400/20 dark:bg-sky-500/[0.06]",
        )}
      >
        <p className="text-sm font-semibold">
          {!assessment ? "Not analysed yet" : blocked ? "Blocked: depends on a feature that is not built" : "Not blocked: can be tested without the missing feature"}
        </p>
        {assessment && <Text className="mt-1 text-slate-700 dark:text-zinc-300">{assessment.reason}</Text>}
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
          <span>{assessment ? (assessment.source === "ai" ? `Gemini, ${assessment.confidence ?? "unknown"} confidence` : "Keyword match") : "Press Filter on the board"}</span>
          {features.length > 0 && (
            <>
              <span>·</span>
              {features.map((k) => (
                <span key={k} className="rounded-full bg-white px-1.5 py-0.5 font-medium text-slate-700 ring-1 ring-slate-200 ring-inset dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10">
                  {k}
                </span>
              ))}
            </>
          )}
        </p>
      </div>
    </section>
  );
}

const cellText = (value: CellValue) => (value === null || value === undefined ? "" : String(value).trim());

function WorkbookRowView({ row }: { row: WorkbookRow }) {
  const entries = Object.entries(row.values)
    .map(([name, value]) => [name, cellText(value)] as const)
    .filter(([, value]) => value);
  const isLong = ([name, value]: readonly [string, string]) => LONG_FIELD.test(name) || value.length > 70 || value.includes("\n");
  const short = entries.filter((e) => !isLong(e));
  const long = entries.filter(isLong);
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200/80 dark:border-white/[0.07]">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2 text-xs text-slate-500 dark:border-white/[0.06] dark:bg-white/[0.03] dark:text-zinc-400">
        <span className="font-medium text-slate-700 dark:text-zinc-200">{row.sheet}</span>
        <span>row {row.rowNumber}</span>
        <span className="ml-auto">{row.scope === "needsConfirmation" ? "Needs confirmation" : "In scope"}</span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-3.5">
        {short.length > 0 && (
          <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
            {short.map(([name, value]) => (
              <div key={name} className="min-w-0">
                <dt className="text-xs text-slate-500 dark:text-zinc-500">{name}</dt>
                <dd className="text-sm break-words text-slate-800 dark:text-zinc-200">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {long.map(([name, value]) => (
          <div key={name}>
            <p className="mb-1 text-xs text-slate-500 dark:text-zinc-500">{name}</p>
            <div className="well px-3 py-2.5">
              <Text>{value}</Text>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpiraSection({ projectId, testCaseId, configured }: { projectId: number; testCaseId: number; configured: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!configured) return;
    let active = true;
    readTestCase(projectId, testCaseId, attempt > 0).then(
      (detail) => active && setLoaded({ testCaseId, detail, error: null }),
      (err) => active && setLoaded({ testCaseId, detail: null, error: errorMessage(err) }),
    );
    return () => {
      active = false;
    };
  }, [projectId, testCaseId, configured, attempt]);

  const current = loaded?.testCaseId === testCaseId ? loaded : null;
  const detail = current?.detail ?? null;
  const loading = configured && !current;
  const retry = () => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  };

  if (!configured) {
    return (
      <section>
        <Heading>In Spira</Heading>
        <Notice tone="warning">Spira is not connected on the server, so the description and test steps cannot be loaded.</Notice>
      </section>
    );
  }

  const properties = detail
    ? ([
        ["Status", detail.status],
        ["Priority", detail.priority],
        ["Type", detail.type],
        ["Owner", detail.owner],
        ["Author", detail.author],
        ...detail.customFields.map((f) => [f.name, f.value] as const),
      ].filter(([, v]) => v) as Array<readonly [string, string]>)
    : [];

  return (
    <>
      <section>
        <Heading aside={current && <RefreshButton onClick={retry} />}>In Spira</Heading>
        {loading && <SkeletonLines lines={3} />}
        {current?.error && (
          <Notice tone="danger" title="Could not load this test case from Spira" action={<Button size="sm" icon={RefreshCw} onClick={retry}>Retry</Button>}>
            {current.error}
          </Notice>
        )}
        {detail && (
          <div className="flex flex-col gap-4">
            {properties.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
                {properties.map(([name, value]) => (
                  <div key={name} className="min-w-0">
                    <dt className="text-xs text-slate-500 dark:text-zinc-500">{name}</dt>
                    <dd className="truncate text-sm text-slate-800 dark:text-zinc-200" title={value}>
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {detail.description ? (
              <div>
                <p className="mb-1 text-xs text-slate-500 dark:text-zinc-500">Description</p>
                <div className="well px-3 py-2.5">
                  <Text>{detail.description}</Text>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </section>

      <section>
        <Heading aside={detail && <span className="text-xs text-slate-500 tabular-nums">{countSteps(detail.steps)} step{countSteps(detail.steps) === 1 ? "" : "s"}</span>}>
          Test steps
        </Heading>
        {loading && <SkeletonLines lines={6} />}
        {detail && detail.steps.length === 0 && <p className="text-sm text-slate-500 dark:text-zinc-500">This test case has no steps in Spira.</p>}
        {detail && detail.steps.length > 0 && <Steps steps={detail.steps} prefix="" />}
        {detail?.truncated && <p className="mt-3 text-xs text-slate-500">Very long: only the first steps are shown. Open it in Spira to see the rest.</p>}
      </section>
    </>
  );
}

function countSteps(steps: TestCaseStep[]): number {
  return steps.reduce((n, s) => n + (s.linkedTestCaseId ? countSteps(s.linkedSteps) : 1), 0);
}

function Steps({ steps, prefix }: { steps: TestCaseStep[]; prefix: string }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps.map((step, i) => {
        const number = `${prefix}${i + 1}`;
        return (
          <li key={`${step.position}-${i}`} className="flex gap-3 rounded-xl border border-slate-200/80 px-4 py-3.5 dark:border-white/[0.07]">
            <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-slate-100 px-1.5 text-xs font-semibold text-slate-600 tabular-nums dark:bg-white/[0.07] dark:text-zinc-300">
              {number}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              {step.linkedTestCaseId ? (
                <>
                  <p className="text-sm text-slate-700 dark:text-zinc-300">
                    Calls <span className="font-mono text-xs">TC{step.linkedTestCaseId}</span>
                    {step.linkedName && <span className="font-medium text-slate-900 dark:text-white"> {step.linkedName}</span>}
                  </p>
                  {step.linkedSteps.length > 0 && (
                    <div className="border-l-2 border-slate-100 pl-3 dark:border-white/[0.06]">
                      <Steps steps={step.linkedSteps} prefix={`${number}.`} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  {step.precondition && <Labeled label="Precondition">{step.precondition}</Labeled>}
                  <Text>{step.description || "No description."}</Text>
                  {(step.expectedResult || step.sampleData) && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {step.expectedResult && <Labeled label="Expected result">{step.expectedResult}</Labeled>}
                      {step.sampleData && <Labeled label="Test data">{step.sampleData}</Labeled>}
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Labeled({ label, children }: { label: string; children: string }) {
  return (
    <div className="well min-w-0 px-3 py-2">
      <p className="mb-0.5 text-[11px] font-medium text-slate-500 dark:text-zinc-500">{label}</p>
      <Text>{children}</Text>
    </div>
  );
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex cursor-pointer items-center gap-1 text-xs text-slate-500 transition hover:text-slate-900 dark:hover:text-white">
      <RefreshCw className="size-3" aria-hidden /> Reload
    </button>
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
