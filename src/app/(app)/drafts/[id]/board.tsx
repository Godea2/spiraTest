"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, ButtonLink, Dialog, Field, Notice, PageHeader, Spinner, Stat } from "@/components/ui";
import { useSettings } from "@/components/settings-context";
import { errorMessage } from "@/lib/client/api";
import { DraftConflictError, mutateDraft, renameDraft } from "@/lib/client/drafts";
import { exportBoard } from "@/lib/client/exports";
import { formatDateTime, relativeTime, STATUS_LABEL, STATUS_TONE } from "@/lib/client/format";
import { useDraft } from "@/lib/client/use-draft";
import { compareTestSet } from "@/lib/client/workflow";
import { recordBoardEdits } from "@/lib/domain/draft-ops";
import {
  allCards,
  applyChanges,
  countColumns,
  effectiveColumn,
  isComparisonComplete,
  moveCards,
} from "@/lib/domain/board";
import {
  COLUMN_LABELS,
  COLUMNS,
  type Card,
  type CardChange,
  type Column,
  type Draft,
  type HistoryEntry,
} from "@/lib/domain/types";
import { blockMatchingCards, keywordHits } from "@/lib/domain/keywords";
import { BoardCard, BoardColumn } from "./board-parts";
import { KeywordPanel } from "./keyword-panel";

const AUTOSAVE_MS = 30_000;
const KEY_TO_COLUMN: Record<string, Column> = { "1": "inScope", "2": "blocked", "3": "outOfScope", "4": "needsReview" };

type StatusFilter = "all" | "executed" | "notExecuted" | "manual" | "keyword";
type Confirm = { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; run: () => void } | null;

function describeMove(changes: CardChange[], to?: Column) {
  const n = changes.length;
  return `Moved ${n} card${n === 1 ? "" : "s"}${to ? ` to ${COLUMN_LABELS[to]}` : ""}`;
}

export function Board({ id }: { id: string }) {
  const router = useRouter();
  const { settings } = useSettings();
  const { draft, setDraft, error: loadError, reload } = useDraft(id);

  const [decisions, setDecisions] = useState<Record<string, Column>>({});
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [undoStack, setUndoStack] = useState<CardChange[][]>([]);
  const [redoStack, setRedoStack] = useState<CardChange[][]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [setFilter, setSetFilter] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const lastToggled = useRef<string | null>(null);
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [recompare, setRecompare] = useState<{ running: boolean; error: string | null; done: number; total: number } | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const hydrate = useCallback((d: Draft) => {
    setDecisions(d.decisions);
    setHistory(d.history);
    setDirty(false);
    setSavedAt(d.updatedAt);
  }, []);

  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (draft && hydratedFor.current !== draft.id) {
      hydratedFor.current = draft.id;
      hydrate(draft);
    }
  }, [draft, hydrate]);

  const cards = useMemo(() => (draft ? allCards(draft.testSets) : []), [draft]);
  const cardByKey = useMemo(() => new Map(cards.map((c) => [c.key, c])), [cards]);
  const setNames = useMemo(() => new Map(draft?.testSets.map((s) => [s.testSetId, s.testSetName]) ?? []), [draft]);
  const counts = useMemo(() => countColumns(cards, decisions), [cards, decisions]);
  const missingCount = draft?.testSets.reduce((n, s) => n + s.missingFromSpira.length, 0) ?? 0;
  const hits = useMemo(
    () => keywordHits(cards, draft?.testSetKeywords, draft?.stepText),
    [cards, draft?.testSetKeywords, draft?.stepText],
  );
  const pendingBlocks = useMemo(
    () => cards.filter((c) => hits.has(c.key) && effectiveColumn(c, decisions) === "inScope").length,
    [cards, hits, decisions],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards.filter((card) => {
      if (setFilter !== "all" && card.testSetId !== setFilter) return false;
      if (statusFilter === "executed" && !card.executed) return false;
      if (statusFilter === "notExecuted" && card.executed) return false;
      if (statusFilter === "manual" && !decisions[card.key]) return false;
      if (statusFilter === "keyword" && !hits.has(card.key)) return false;
      if (!q) return true;
      return `${card.name} ${card.tcId ?? ""} ${card.testCaseId} TC${card.testCaseId} ${card.testSetTestCaseId}`.toLowerCase().includes(q);
    });
  }, [cards, setFilter, statusFilter, search, decisions, hits]);

  const byColumn = useMemo(() => {
    const grouped: Record<Column, Card[]> = { inScope: [], blocked: [], outOfScope: [], needsReview: [] };
    for (const card of filtered) grouped[effectiveColumn(card, decisions)].push(card);
    return grouped;
  }, [filtered, decisions]);

  const totalsInScope = useMemo(() => {
    const scoped = setFilter === "all" ? cards : cards.filter((c) => c.testSetId === setFilter);
    return countColumns(scoped, decisions);
  }, [cards, setFilter, decisions]);

  // ---- saving -------------------------------------------------------------
  const stateRef = useRef({ decisions, history, dirty, draft });
  useEffect(() => {
    stateRef.current = { decisions, history, dirty, draft };
  });

  const inflight = useRef<Promise<boolean> | null>(null);
  const save = useCallback((): Promise<boolean> => {
    inflight.current ??= persist().finally(() => {
      inflight.current = null;
    });
    return inflight.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function persist(): Promise<boolean> {
    const { decisions: d, history: h, dirty: isDirty, draft: current } = stateRef.current;
    if (!current || !isDirty) return true;
    setSaving(true);
    try {
      const saved = mutateDraft(current.id, (draftCopy) => recordBoardEdits(draftCopy, { decisions: d, history: h }), current.updatedAt);
      setDraft(saved);
      setSavedAt(saved.updatedAt);
      setSaveError(null);
      if (stateRef.current.decisions === d && stateRef.current.history === h) setDirty(false);
      return true;
    } catch (err) {
      setSaveError({ message: errorMessage(err), conflict: err instanceof DraftConflictError });
      return false;
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (stateRef.current.dirty) void save();
    }, AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (stateRef.current.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // ---- moves ----------------------------------------------------------------
  const record = useCallback((label: string, changes: CardChange[]) => {
    setHistory((h) => [...h, { at: new Date().toISOString(), label, changes }]);
    setDirty(true);
  }, []);

  const withExecutedGuard = useCallback(
    (changes: CardChange[], run: () => void, action = "move") => {
      const executed = changes.filter((c) => c.to === "outOfScope" && cardByKey.get(c.key)?.executed);
      if (executed.length === 0) return run();
      setConfirm({
        title: `Move ${executed.length} executed case${executed.length === 1 ? "" : "s"} to Out of Scope?`,
        body: (
          <>
            <p>These cases already have execution results. Applying this draft will remove them from their test set, and their results will no longer appear there.</p>
            <ul className="mt-3 max-h-40 list-disc overflow-y-auto pl-5 text-xs">
              {executed.slice(0, 20).map((c) => {
                const card = cardByKey.get(c.key)!;
                return <li key={c.key}>{card.name} · {card.executionStatus}</li>;
              })}
              {executed.length > 20 && <li>…and {executed.length - 20} more</li>}
            </ul>
          </>
        ),
        confirmLabel: action === "move" ? "Move anyway" : "Continue",
        danger: true,
        run,
      });
    },
    [cardByKey],
  );

  const move = useCallback(
    (keys: string[], to: Column) => {
      const { decisions: next, changes } = moveCards(cards, decisions, keys, to);
      if (changes.length === 0) return;
      withExecutedGuard(changes, () => {
        setDecisions(next);
        setUndoStack((s) => [...s, changes]);
        setRedoStack([]);
        record(describeMove(changes, to), changes);
        setSelection(new Set());
      });
    },
    [cards, decisions, record, withExecutedGuard],
  );

  const undo = useCallback(() => {
    const changes = undoStack.at(-1);
    if (!changes) return;
    const inverse = changes.map((c) => ({ key: c.key, from: c.to, to: c.from }));
    withExecutedGuard(inverse, () => {
      setDecisions((d) => applyChanges(cards, d, changes, "undo"));
      setUndoStack((s) => s.slice(0, -1));
      setRedoStack((s) => [...s, changes]);
      record(`Undo: ${describeMove(changes)}`, inverse);
    }, "undo");
  }, [undoStack, cards, record, withExecutedGuard]);

  const redo = useCallback(() => {
    const changes = redoStack.at(-1);
    if (!changes) return;
    withExecutedGuard(changes, () => {
      setDecisions((d) => applyChanges(cards, d, changes, "redo"));
      setRedoStack((s) => s.slice(0, -1));
      setUndoStack((s) => [...s, changes]);
      record(`Redo: ${describeMove(changes)}`, changes);
    }, "redo");
  }, [redoStack, cards, record, withExecutedGuard]);

  /** Adopts a draft written outside the board's own save (keywords, step text) so the next save does not conflict. */
  const adoptDraft = useCallback(
    (d: Draft) => {
      stateRef.current = { ...stateRef.current, draft: d };
      setDraft(d);
    },
    [setDraft],
  );

  const blockMatches = useCallback(
    (d: Draft) => {
      const { decisions: next, changes, hits: found } = blockMatchingCards(cards, stateRef.current.decisions, d.testSetKeywords, d.stepText);
      if (changes.length === 0) return 0;
      const mentioned = [...new Set(changes.flatMap((c) => found.get(c.key) ?? []))];
      setDecisions(next);
      setUndoStack((s) => [...s, changes]);
      setRedoStack([]);
      record(`${describeMove(changes, "blocked")}: they mention ${mentioned.join(", ")}`, changes);
      return changes.length;
    },
    [cards, record],
  );

  const reset = () => {
    const changes: CardChange[] = Object.entries(decisions).flatMap(([key, from]) => {
      const card = cardByKey.get(key);
      return card ? [{ key, from, to: card.suggestion }] : [];
    });
    if (changes.length === 0) return;
    setConfirm({
      title: "Reset all manual moves?",
      body: `${changes.length} card${changes.length === 1 ? "" : "s"} will return to the suggested column. You can undo this.`,
      confirmLabel: "Reset board",
      run: () =>
        withExecutedGuard(changes, () => {
          setDecisions({});
          setUndoStack((s) => [...s, changes]);
          setRedoStack([]);
          record("Reset to suggestions", changes);
        }, "reset"),
    });
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, dialog")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      } else if (e.key === "Escape") {
        setSelection(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, save]);

  // ---- selection ------------------------------------------------------------
  const toggle = useCallback(
    (key: string, range: boolean) => {
      setSelection((current) => {
        const next = new Set(current);
        const anchor = lastToggled.current;
        const anchorCard = anchor ? cardByKey.get(anchor) : null;
        const card = cardByKey.get(key);
        if (range && anchorCard && card && effectiveColumn(anchorCard, decisions) === effectiveColumn(card, decisions)) {
          const list = byColumn[effectiveColumn(card, decisions)];
          const a = list.findIndex((c) => c.key === anchor);
          const b = list.findIndex((c) => c.key === key);
          for (const c of list.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(c.key);
        } else if (next.has(key)) next.delete(key);
        else next.add(key);
        lastToggled.current = key;
        return next;
      });
    },
    [byColumn, cardByKey, decisions],
  );

  const selectMany = useCallback((keys: string[], select: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (select) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const moveOne = useCallback(
    (key: string, to: Column) => move(selection.has(key) ? [...selection] : [key], to),
    [move, selection],
  );

  const onCardKey = useCallback(
    (e: KeyboardEvent<HTMLDivElement>, card: Card) => {
      const to = KEY_TO_COLUMN[e.key];
      if (to) {
        e.preventDefault();
        moveOne(card.key, to);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        toggle(card.key, e.shiftKey);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-card-key]");
        if (!list) return;
        const items = [...list];
        const index = items.indexOf(e.currentTarget);
        items[index + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
    },
    [moveOne, toggle],
  );

  // ---- drag and drop ----------------------------------------------------------
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const onDragStart = (e: DragStartEvent) => setActiveDrag(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const to = e.over?.id as Column | undefined;
    if (!to || !COLUMNS.includes(to)) return;
    moveOne(String(e.active.id), to);
  };
  const dragCount = activeDrag && selection.has(activeDrag) ? selection.size : 1;

  // ---- other actions -------------------------------------------------------------
  async function rename() {
    if (!draft || !renaming?.trim()) return;
    try {
      setDraft(renameDraft(draft.id, renaming, draft.updatedAt));
      setRenaming(null);
    } catch (err) {
      setSaveError({ message: errorMessage(err), conflict: err instanceof DraftConflictError });
      setRenaming(null);
    }
  }

  async function runRecompare(testSetIds: number[]) {
    if (!draft) return;
    if (!(await save())) return;
    setRecompare({ running: true, error: null, done: 0, total: testSetIds.length });
    let latest: Draft | null = null;
    for (const [i, testSetId] of testSetIds.entries()) {
      try {
        latest = await compareTestSet(draft.id, testSetId, settings?.mappings ?? []);
        setRecompare((r) => r && { ...r, done: i + 1 });
      } catch (err) {
        setRecompare({ running: false, error: `${setNames.get(testSetId) ?? testSetId}: ${errorMessage(err)}`, done: i, total: testSetIds.length });
        break;
      }
    }
    const fresh = await reload();
    if (fresh) hydrate(fresh);
    setUndoStack([]);
    setRedoStack([]);
    setSelection(new Set());
    setRecompare((r) => (r?.error ? r : latest ? null : r));
  }

  async function goToReview() {
    if (await save()) router.push(`/drafts/${id}/review`);
  }

  // ---- render ---------------------------------------------------------------
  if (loadError && !draft) {
    return <Notice tone="danger" title="This draft could not be opened" action={<ButtonLink href="/drafts" size="sm">Back to drafts</ButtonLink>}>{loadError}</Notice>;
  }
  if (!draft) {
    return <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading board…</div>;
  }

  const complete = isComparisonComplete(draft);
  const missingSets = draft.testSetIds.filter((tid) => !draft.testSets.some((s) => s.testSetId === tid));
  const activeCard = activeDrag ? cardByKey.get(activeDrag) : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            {draft.module}
            {draft.releaseLabel || draft.releaseId ? ` · Release ${draft.releaseLabel || draft.releaseId}` : ""}
            <Badge tone={STATUS_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>          </span>
        }
        title={
          <button type="button" className="text-left hover:underline decoration-zinc-300 underline-offset-4" onClick={() => setRenaming(draft.name)} title="Rename draft">
            {draft.name}
          </button>
        }
        actions={
          <>
            <span className="mr-1 text-xs text-zinc-500" aria-live="polite">
              {saving ? "Saving…" : dirty ? "Unsaved changes" : savedAt ? `Saved ${relativeTime(savedAt)}` : ""}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void save()} disabled={!dirty || saving}>Save</Button>
            <Button size="sm" onClick={() => exportBoard({ ...draft, decisions, history })}>Export</Button>
            <Button size="sm" onClick={() => setConfirm({
              title: "Recompare with Spira?",
              body: "Each test set is reconciled again. Manual moves are kept for cases that are still present; cases that disappeared are dropped.",
              confirmLabel: "Recompare",
              run: () => void runRecompare(draft.testSetIds),
            })} disabled={!!recompare?.running}>Recompare</Button>
            <Button size="sm" variant="primary" onClick={goToReview} disabled={!complete}>Review &amp; apply</Button>
          </>
        }
      />

      {saveError && (
        <Notice
          tone="danger"
          title={saveError.conflict ? "Draft changed elsewhere" : "Could not save"}
          action={saveError.conflict ? (
            <Button size="sm" onClick={async () => { const fresh = await reload(); if (fresh) hydrate(fresh); setSaveError(null); setUndoStack([]); setRedoStack([]); }}>Reload latest</Button>
          ) : (
            <Button size="sm" onClick={() => void save()}>Retry</Button>
          )}
        >
          {saveError.message}
        </Notice>
      )}

      {!complete && (
        <Notice tone="warning" title="Comparison incomplete" action={<Button size="sm" onClick={() => void runRecompare(missingSets)} busy={recompare?.running}>Compare remaining</Button>}>
          {missingSets.length} test set{missingSets.length === 1 ? "" : "s"} still need a successful comparison before review.
          {Object.values(draft.compareErrors)[0] && <> Last error: {Object.values(draft.compareErrors)[0]}</>}
        </Notice>
      )}
      {recompare?.running && (
        <Notice tone="info"><span className="flex items-center gap-2"><Spinner className="size-3.5" /> Recomparing {recompare.done} / {recompare.total}…</span></Notice>
      )}
      {recompare?.error && <Notice tone="danger" title="Recompare stopped" action={<Button size="sm" onClick={() => setRecompare(null)}>Dismiss</Button>}>{recompare.error}</Notice>}
      {counts.needsReview > 0 && complete && (
        <Notice tone="warning">
          {counts.needsReview} card{counts.needsReview === 1 ? "" : "s"} in Needs Review. Move each to In Scope, Blocked or Out of Scope before a live apply.
        </Notice>
      )}

      <dl className="surface grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total cards" value={counts.total} />
        <Stat label="In Scope" value={counts.inScope} />
        <Stat label="Blocked · not implemented" value={counts.blocked} />
        <Stat label="Out of Scope · to remove" value={counts.outOfScope} tone={counts.outOfScope ? "danger" : undefined} />
        <Stat label="Needs Review" value={counts.needsReview} tone={counts.needsReview ? "warning" : "success"} />
        <Stat label="Missing from Spira" value={missingCount} />
      </dl>

      {complete && (
        <KeywordPanel
          draft={draft}
          cards={cards}
          decisions={decisions}
          pending={pendingBlocks}
          onDraft={adoptDraft}
          onBlockMatches={blockMatches}
        />
      )}

      <div className="flex flex-col gap-3">
        {draft.testSets.length > 1 && (
          <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label="Test set">
            {[{ id: "all" as const, label: "All test sets" }, ...draft.testSets.map((s) => ({ id: s.testSetId, label: s.testSetName }))].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={setFilter === tab.id}
                onClick={() => setSetFilter(tab.id)}
                className={clsx(
                  "rounded-lg px-3 py-1.5 text-sm whitespace-nowrap",
                  setFilter === tab.id ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="search" className="input sm:max-w-xs" placeholder="Search name, TC ID or case ID" aria-label="Search cards" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input sm:w-48" aria-label="Filter cards" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="all">All cards</option>
            <option value="executed">Executed</option>
            <option value="notExecuted">Not executed</option>
            <option value="manual">Moved manually</option>
            <option value="keyword">Mentions a keyword</option>
          </select>
          <div className="flex items-center gap-1 sm:ml-auto">
            <Button size="sm" variant="ghost" onClick={undo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">Undo</Button>
            <Button size="sm" variant="ghost" onClick={redo} disabled={redoStack.length === 0} title="Redo (Ctrl+Y)">Redo</Button>
            <Button size="sm" variant="ghost" onClick={reset} disabled={Object.keys(decisions).length === 0}>Reset</Button>
          </div>
        </div>
        <p className="hidden text-xs text-zinc-500 lg:block">
          Drag cards between columns, or focus a card and press <kbd className="kbd">Space</kbd> to select, <kbd className="kbd">1</kbd> <kbd className="kbd">2</kbd> <kbd className="kbd">3</kbd> <kbd className="kbd">4</kbd> to move, <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to navigate.
        </p>
      </div>

      {selection.size > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 shadow-sm dark:border-brand-800 dark:bg-brand-950/80">
          <span className="text-sm font-medium">{selection.size} selected</span>
          <span className="text-sm text-zinc-500">Move to</span>
          {COLUMNS.map((c) => (
            <Button key={c} size="sm" onClick={() => move([...selection], c)}>{COLUMN_LABELS[c]}</Button>
          ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelection(new Set())}>Clear</Button>
        </div>
      )}

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveDrag(null)}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((column) => (
            <BoardColumn
              key={column}
              column={column}
              cards={byColumn[column]}
              total={totalsInScope[column]}
              selectedInColumn={byColumn[column].filter((c) => selection.has(c.key)).length}
              onSelectAll={selectMany}
            >
              {(card) => (
                <BoardCard
                  key={card.key}
                  card={card}
                  column={column}
                  setName={setFilter === "all" && draft.testSets.length > 1 ? setNames.get(card.testSetId) ?? null : null}
                  keywords={hits.get(card.key)}
                  moved={Boolean(decisions[card.key])}
                  selected={selection.has(card.key)}
                  onToggle={toggle}
                  onMove={moveOne}
                  onKey={onCardKey}
                />
              )}
            </BoardColumn>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeCard && (
            <div className="rounded-lg border border-brand-500 bg-white p-3 text-sm font-medium shadow-lg dark:bg-zinc-900">
              {dragCount > 1 ? `${dragCount} cards` : activeCard.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <section className="surface">
        <button type="button" className="flex w-full items-center justify-between px-5 py-4 text-left" aria-expanded={showMissing} onClick={() => setShowMissing((v) => !v)}>
          <span className="font-semibold">Missing from Spira <span className="font-normal text-zinc-500">({missingCount})</span></span>
          <span className="text-sm text-zinc-500">{showMissing ? "Hide" : "Show"}</span>
        </button>
        {showMissing && (
          <div className="overflow-x-auto border-t border-zinc-100 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-500"><tr><th className="px-5 py-2 font-medium">TC ID</th><th className="px-5 py-2 font-medium">Scenario</th><th className="px-5 py-2 font-medium">Test set</th><th className="px-5 py-2 font-medium">Reason</th></tr></thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {draft.testSets.flatMap((s) => s.missingFromSpira.map((row, i) => (
                  <tr key={`${s.testSetId}-${i}`}><td className="px-5 py-2 font-mono text-xs">{row.tcId}</td><td className="px-5 py-2">{row.testScenario}</td><td className="px-5 py-2 text-zinc-500">{s.testSetName}</td><td className="px-5 py-2 text-zinc-500">{row.reason}</td></tr>
                )))}
                {missingCount === 0 && <tr><td colSpan={4} className="px-5 py-4 text-zinc-500">Every workbook row has a matching Spira test case.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface">
        <button type="button" className="flex w-full items-center justify-between px-5 py-4 text-left" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
          <span className="font-semibold">Change history <span className="font-normal text-zinc-500">({history.length})</span></span>
          <span className="text-sm text-zinc-500">{showHistory ? "Hide" : "Show"}</span>
        </button>
        {showHistory && (
          <ol className="divide-y divide-zinc-100 border-t border-zinc-100 text-sm dark:divide-zinc-800 dark:border-zinc-800">
            {[...history].reverse().slice(0, 200).map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="flex gap-4 px-5 py-2.5">
                <span className="w-28 shrink-0 text-xs text-zinc-500">{formatDateTime(entry.at)}</span>
                <span>{entry.label}</span>
              </li>
            ))}
            {history.length === 0 && <li className="px-5 py-4 text-zinc-500">No changes yet.</li>}
          </ol>
        )}
      </section>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.title}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant={confirm?.danger ? "danger" : "primary"}
              onClick={() => {
                const run = confirm?.run;
                setConfirm(null);
                run?.();
              }}
            >
              {confirm?.confirmLabel}
            </Button>
          </>
        }
      >
        {confirm?.body}
      </Dialog>

      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename draft"
        footer={<><Button onClick={() => setRenaming(null)}>Cancel</Button><Button variant="primary" onClick={rename} disabled={!renaming?.trim()}>Save</Button></>}
      >
        <Field label="Name">
          {(props) => <input {...props} className="input" autoFocus maxLength={160} value={renaming ?? ""} onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void rename()} />}
        </Field>
      </Dialog>
    </div>
  );
}
