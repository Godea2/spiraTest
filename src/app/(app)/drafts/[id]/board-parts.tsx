"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import { Ban, CheckCircle2, CircleHelp, Hand, MinusCircle, Sparkles, Tag, type LucideIcon } from "lucide-react";
import { memo, useState, type KeyboardEvent } from "react";
import { COLUMN_LABELS, COLUMNS, type BlockedAssessment, type Card, type Column } from "@/lib/domain/types";

const PAGE = 150;

export const COLUMN_STYLE: Record<
  Column,
  { dot: string; ring: string; key: string; icon: LucideIcon; accent: string; chip: string; tint: string }
> = {
  inScope: {
    dot: "bg-emerald-500",
    ring: "ring-emerald-500/50",
    key: "1",
    icon: CheckCircle2,
    accent: "text-emerald-600 dark:text-emerald-400",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
    tint: "from-emerald-500/[0.07]",
  },
  blocked: {
    dot: "bg-orange-500",
    ring: "ring-orange-500/50",
    key: "2",
    icon: Ban,
    accent: "text-orange-600 dark:text-orange-400",
    chip: "bg-orange-50 text-orange-700 ring-orange-200/70 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20",
    tint: "from-orange-500/[0.07]",
  },
  outOfScope: {
    dot: "bg-rose-500",
    ring: "ring-rose-500/50",
    key: "3",
    icon: MinusCircle,
    accent: "text-rose-600 dark:text-rose-400",
    chip: "bg-rose-50 text-rose-700 ring-rose-200/70 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20",
    tint: "from-rose-500/[0.07]",
  },
  needsReview: {
    dot: "bg-amber-500",
    ring: "ring-amber-500/50",
    key: "4",
    icon: CircleHelp,
    accent: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
    tint: "from-amber-500/[0.08]",
  },
};

const SHORT: Record<Column, string> = { inScope: "In", blocked: "Blocked", outOfScope: "Out", needsReview: "Review" };

export function AssessmentBadge({ assessment, className }: { assessment: BlockedAssessment; className?: string }) {
  const ai = assessment.source === "ai";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        assessment.blocked
          ? "bg-orange-50 text-orange-700 ring-orange-200/70 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20"
          : "bg-sky-50 text-sky-700 ring-sky-200/70 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20",
        className,
      )}
      title={`${ai ? "AI review" : "Keyword match"}${assessment.confidence ? ` (${assessment.confidence} confidence)` : ""}: ${assessment.reason}`}
    >
      {ai ? <Sparkles className="size-3" aria-hidden /> : <Tag className="size-3" aria-hidden />}
      {assessment.blocked ? "Blocked" : "Not blocked"}
      {ai && assessment.confidence && <span className="opacity-70">· {assessment.confidence}</span>}
    </span>
  );
}

interface CardProps {
  card: Card;
  column: Column;
  setName: string | null;
  /** Not-implemented keywords this case's scenario mentions. */
  keywords: string[] | undefined;
  assessment: BlockedAssessment | null;
  moved: boolean;
  selected: boolean;
  onToggle: (key: string, range: boolean) => void;
  onMove: (key: string, to: Column) => void;
  onKey: (event: KeyboardEvent<HTMLDivElement>, card: Card) => void;
}

export const BoardCard = memo(function BoardCard({ card, column, setName, keywords, assessment, moved, selected, onToggle, onMove, onKey }: CardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.key });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role="listitem"
      tabIndex={0}
      aria-roledescription="Draggable card"
      aria-label={`${card.name}. ${COLUMN_LABELS[column]}${card.executed ? ", executed" : ""}${moved ? ", moved manually" : ""}${selected ? ", selected" : ""}`}
      data-card-key={card.key}
      onKeyDown={(e) => onKey(e, card)}
      className={clsx(
        "group relative cursor-grab touch-manipulation rounded-xl border bg-white p-3 text-left transition-all duration-150 select-none active:cursor-grabbing dark:bg-zinc-900",
        selected
          ? "border-brand-400 shadow-glow dark:border-brand-400/60"
          : "border-slate-200/80 shadow-xs hover:-translate-y-px hover:border-slate-300 hover:shadow-soft dark:border-white/[0.07] dark:hover:border-white/15",
        isDragging && "opacity-40",
      )}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${card.name}`}
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(card.key, e.shiftKey);
          }}
          onChange={() => undefined}
          className="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-brand-600"
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] leading-snug font-medium text-slate-800 dark:text-zinc-100">{card.name}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500 dark:text-zinc-500">
            {card.tcId && <span className="font-mono text-slate-600 dark:text-zinc-400">{card.tcId}</span>}
            <span className="font-mono">TC{card.testCaseId}</span>
            {setName && <span className="truncate">· {setName}</span>}
          </p>
          {(card.executed || moved || (keywords && keywords.length > 0) || assessment) && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {card.executed && (
                <span className="rounded-full bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 ring-1 ring-violet-200/70 ring-inset dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20">
                  {card.executionStatus}
                </span>
              )}
              {moved && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 ring-1 ring-brand-200/70 ring-inset dark:bg-brand-500/10 dark:text-brand-200 dark:ring-brand-400/20"
                  title={`Suggested: ${COLUMN_LABELS[card.suggestion]}`}
                >
                  <Hand className="size-3" aria-hidden />
                  Moved
                </span>
              )}
              {keywords?.map((k) => (
                <span key={k} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-slate-200 ring-inset dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10" title="Not-implemented keyword in the scenario">
                  <Tag className="size-3" aria-hidden />
                  {k}
                </span>
              ))}
              {assessment && <AssessmentBadge assessment={assessment} />}
            </div>
          )}
          {card.reason && <p className="mt-1.5 line-clamp-1 text-[11px] text-slate-500 dark:text-zinc-500" title={card.reason}>{card.reason}</p>}
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
        {COLUMNS.filter((c) => c !== column).map((to) => (
          <button
            key={to}
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onMove(card.key, to);
            }}
            className={clsx("cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset transition hover:brightness-95", COLUMN_STYLE[to].chip)}
            title={`Move to ${COLUMN_LABELS[to]} (${COLUMN_STYLE[to].key})`}
          >
            → {SHORT[to]}
          </button>
        ))}
      </div>
    </div>
  );
});

export function BoardColumn({
  column,
  cards,
  total,
  children,
  selectedInColumn,
  onSelectAll,
}: {
  column: Column;
  cards: Card[];
  total: number;
  children: (card: Card) => React.ReactNode;
  selectedInColumn: number;
  onSelectAll: (keys: string[], select: boolean) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column });
  const [limit, setLimit] = useState(PAGE);
  const visible = cards.slice(0, limit);
  const allSelected = cards.length > 0 && selectedInColumn === cards.length;
  const style = COLUMN_STYLE[column];
  const Icon = style.icon;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${COLUMN_LABELS[column]} column`}
      className={clsx(
        "flex min-h-72 flex-col overflow-hidden rounded-2xl border bg-gradient-to-b to-transparent to-40% transition-all duration-200",
        style.tint,
        isOver
          ? `scale-[1.01] border-transparent bg-slate-100/80 ring-2 dark:bg-white/[0.04] ${style.ring}`
          : "border-slate-200/80 bg-slate-100/50 dark:border-white/[0.06] dark:bg-white/[0.02]",
      )}
    >
      <header className="flex items-center gap-2 px-3.5 pt-3.5 pb-2.5">
        <Icon className={clsx("size-4", style.accent)} aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">{COLUMN_LABELS[column]}</h2>
        <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ring-1 ring-inset", style.chip)}>
          {cards.length}
          {cards.length !== total && <span className="opacity-60"> / {total}</span>}
        </span>
        <button
          type="button"
          className="ml-auto cursor-pointer rounded-md px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-white hover:text-slate-800 disabled:cursor-default disabled:opacity-40 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
          disabled={cards.length === 0}
          onClick={() => onSelectAll(cards.map((c) => c.key), !allSelected)}
        >
          {allSelected ? "Clear" : "Select all"}
        </button>
      </header>
      <div role="list" className="card-list flex flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-2.5 lg:max-h-[calc(100dvh-18rem)]">
        {visible.map((card) => children(card))}
        {cards.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-3 py-10 text-center text-xs text-slate-500 dark:border-white/10 dark:text-zinc-500">
            <Icon className="size-5 opacity-50" aria-hidden />
            Drop cards here
          </div>
        )}
        {cards.length > limit && (
          <button
            type="button"
            className="cursor-pointer rounded-lg py-2 text-xs font-medium text-brand-700 hover:bg-white dark:text-brand-300 dark:hover:bg-white/[0.04]"
            onClick={() => setLimit((l) => l + PAGE)}
          >
            Show {Math.min(PAGE, cards.length - limit)} more
          </button>
        )}
      </div>
    </section>
  );
}
