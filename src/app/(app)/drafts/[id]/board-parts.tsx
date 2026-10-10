"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import { memo, useState, type KeyboardEvent } from "react";
import { COLUMN_LABELS, COLUMNS, type Card, type Column } from "@/lib/domain/types";

const PAGE = 150;

export const COLUMN_STYLE: Record<Column, { dot: string; ring: string; key: string }> = {
  inScope: { dot: "bg-emerald-500", ring: "ring-emerald-500/40", key: "1" },
  blocked: { dot: "bg-orange-500", ring: "ring-orange-500/40", key: "2" },
  outOfScope: { dot: "bg-red-500", ring: "ring-red-500/40", key: "3" },
  needsReview: { dot: "bg-amber-500", ring: "ring-amber-500/40", key: "4" },
};

const SHORT: Record<Column, string> = { inScope: "In", blocked: "Blocked", outOfScope: "Out", needsReview: "Review" };

interface CardProps {
  card: Card;
  column: Column;
  setName: string | null;
  /** Not-implemented keywords this case mentions. */
  keywords: string[] | undefined;
  moved: boolean;
  selected: boolean;
  onToggle: (key: string, range: boolean) => void;
  onMove: (key: string, to: Column) => void;
  onKey: (event: KeyboardEvent<HTMLDivElement>, card: Card) => void;
}

export const BoardCard = memo(function BoardCard({ card, column, setName, keywords, moved, selected, onToggle, onMove, onKey }: CardProps) {
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
        "group relative cursor-grab touch-manipulation rounded-lg border bg-white p-3 text-left shadow-xs transition-shadow select-none active:cursor-grabbing dark:bg-zinc-900",
        selected
          ? "border-brand-500 ring-2 ring-brand-500/30"
          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700",
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
          className="mt-0.5 size-4 shrink-0 accent-brand-600"
        />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm leading-snug font-medium">{card.name}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            {card.tcId && <span className="font-mono">{card.tcId}</span>}
            <span className="font-mono">TC{card.testCaseId}</span>
            {setName && <span className="truncate">{setName}</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {card.executed && (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                {card.executionStatus}
              </span>
            )}
            {moved && (
              <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 dark:bg-brand-900/40 dark:text-brand-200" title={`Suggested: ${COLUMN_LABELS[card.suggestion]}`}>
                Moved
              </span>
            )}
            {keywords && keywords.length > 0 && (
              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[11px] font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" title="Mentions a not-implemented keyword">
                {keywords.join(", ")}
              </span>
            )}
            {card.reason && <span className="line-clamp-1 text-[11px] text-zinc-500" title={card.reason}>{card.reason}</span>}
          </div>
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
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
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
  return (
    <section
      ref={setNodeRef}
      aria-label={`${COLUMN_LABELS[column]} column`}
      className={clsx(
        "flex min-h-64 flex-col rounded-xl border bg-zinc-100/60 transition-colors dark:bg-zinc-900/40",
        isOver ? `border-transparent ring-2 ${COLUMN_STYLE[column].ring}` : "border-zinc-200 dark:border-zinc-800",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className={clsx("size-2 rounded-full", COLUMN_STYLE[column].dot)} aria-hidden />
        <h2 className="text-sm font-semibold">{COLUMN_LABELS[column]}</h2>
        <span className="text-sm text-zinc-500 tabular-nums">
          {cards.length}
          {cards.length !== total && <span className="text-zinc-400"> / {total}</span>}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          disabled={cards.length === 0}
          onClick={() => onSelectAll(cards.map((c) => c.key), !allSelected)}
        >
          {allSelected ? "Clear" : "Select all"}
        </button>
      </header>
      <div role="list" className="card-list flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 lg:max-h-[calc(100dvh-20rem)]">
        {visible.map((card) => children(card))}
        {cards.length === 0 && (
          <p className="rounded-lg border border-dashed border-zinc-300 px-3 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700">
            Drop cards here
          </p>
        )}
        {cards.length > limit && (
          <button
            type="button"
            className="rounded-lg py-2 text-xs font-medium text-brand-700 hover:bg-white dark:text-brand-300 dark:hover:bg-zinc-800"
            onClick={() => setLimit((l) => l + PAGE)}
          >
            Show {Math.min(PAGE, cards.length - limit)} more
          </button>
        )}
      </div>
    </section>
  );
}
