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
import {
  Ban,
  Bug,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleHelp,
  ClipboardCheck,
  Download,
  FileQuestion,
  History,
  Keyboard,
  Layers,
  MinusCircle,
  Pencil,
  Play,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Undo2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, ButtonLink, Collapsible, Dialog, Field, Notice, PageHeader, Spinner, Stat } from "@/components/ui";
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
  isCompleted,
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
import { applyProposals, hasCurrentDeepVerdict, keywordHits, keywordsFor, type BlockedProposal } from "@/lib/domain/keywords";
import { BoardCard, BoardColumn, COLUMN_STYLE } from "./board-parts";
import { CardDetail } from "./card-detail";
import { KeywordPanel } from "./keyword-panel";

const AUTOSAVE_MS = 30_000;
const KEY_TO_COLUMN: Record<string, Column> = { "1": "inScope", "2": "blocked", "3": "outOfScope", "4": "needsReview", "5": "defects" };

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
  const [openKey, setOpenKey] = useState<string | null>(null);
  const dragEndedAt = useRef(0);

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
  const hits = useMemo(() => keywordHits(cards, draft?.testSetKeywords), [cards, draft?.testSetKeywords]);

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
    const grouped: Record<Column, Card[]> = { inScope: [], defects: [], blocked: [], outOfScope: [], needsReview: [] };
    for (const card of filtered) grouped[effectiveColumn(card, decisions)].push(card);
    return grouped;
  }, [filtered, decisions]);

  /** Verdict shown on a card: the keyword-match review, or a deep check made against the current keywords. */
  const assessmentFor = useCallback(
    (card: Card) => {
      const saved = draft?.blockedReview?.[card.key];
      if (!saved) return null;
      if (hits.has(card.key)) return saved;
      return hasCurrentDeepVerdict(saved, keywordsFor(draft?.testSetKeywords, card.testSetId)) && saved.blocked ? saved : null;
    },
    [draft?.blockedReview, draft?.testSetKeywords, hits],
  );

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

  /** Adopts a draft written outside the board's own save (keywords, review verdicts) so the next save does not conflict. */
  const adoptDraft = useCallback(
    (d: Draft) => {
      stateRef.current = { ...stateRef.current, draft: d };
      setDraft(d);
    },
    [setDraft],
  );

  const applyReview = useCallback(
    (proposals: BlockedProposal[], chosen: Set<string>) => {
      const { decisions: next, changes } = applyProposals(cards, stateRef.current.decisions, proposals, chosen);
      const toBlocked = changes.filter((c) => c.to === "blocked").length;
      const toInScope = changes.length - toBlocked;
      if (changes.length === 0) return { toBlocked, toInScope };
      setDecisions(next);
      setUndoStack((s) => [...s, changes]);
      setRedoStack([]);
      const parts = [toBlocked && `${toBlocked} to Blocked`, toInScope && `${toInScope} back to In Scope`].filter(Boolean);
      record(`Not-implemented review: moved ${parts.join(" and ")}`, changes);
      return { toBlocked, toInScope };
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
      } else if (e.key === "Enter") {
        e.preventDefault();
        setOpenKey(card.key);
      } else if (e.key === " ") {
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
    dragEndedAt.current = Date.now();
    const to = e.over?.id as Column | undefined;
    if (!to || !COLUMNS.includes(to)) return;
    moveOne(String(e.active.id), to);
  };
  const dragCount = activeDrag && selection.has(activeDrag) ? selection.size : 1;
  const openCard = useCallback((key: string) => {
    if (Date.now() - dragEndedAt.current > 250) setOpenKey(key);
  }, []);

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

  async function findDefects() {
    if (await save()) router.push(`/defects?draft=${encodeURIComponent(id)}`);
  }

  // ---- render ---------------------------------------------------------------
  if (loadError && !draft) {
    return <Notice tone="danger" title="This draft could not be opened" action={<ButtonLink href="/drafts" size="sm">Back to drafts</ButtonLink>}>{loadError}</Notice>;
  }
  if (!draft) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading board…</div>
        <div className="skeleton h-24" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {COLUMNS.map((c) => <div key={c} className="skeleton h-80 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const complete = isComparisonComplete(draft);
  const missingSets = draft.testSetIds.filter((tid) => !draft.testSets.some((s) => s.testSetId === tid));
  const activeCard = activeDrag ? cardByKey.get(activeDrag) : null;
  const detailCard = openKey ? cardByKey.get(openKey) ?? null : null;
  const detailColumn = detailCard ? effectiveColumn(detailCard, decisions) : null;
  const detailList = detailColumn ? byColumn[detailColumn] : [];
  const detailIndex = detailCard ? detailList.findIndex((c) => c.key === detailCard.key) : -1;
  const neighbour = (offset: number) => {
    const next = detailIndex >= 0 ? detailList[detailIndex + offset] : undefined;
    return next ? () => setOpenKey(next.key) : null;
  };

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
            {draft.releaseLabel || draft.releaseId ? <span className="text-slate-400 dark:text-zinc-500">· Release {draft.releaseLabel || draft.releaseId}</span> : null}
            <Badge tone={STATUS_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>
          </span>
        }
        title={
          <button type="button" className="group inline-flex cursor-pointer items-center gap-2 text-left" onClick={() => setRenaming(draft.name)} title="Rename draft">
            {draft.name}
            <Pencil className="size-4 text-slate-300 opacity-0 transition group-hover:opacity-100 dark:text-zinc-600" aria-hidden />
          </button>
        }
        actions={
          <>
            <span className="mr-1 inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-500" aria-live="polite">
              {saving ? <><Spinner className="size-3" /> Saving…</> : dirty ? <><span className="size-1.5 rounded-full bg-amber-500" /> Unsaved changes</> : savedAt ? <><Check className="size-3.5 text-emerald-500" aria-hidden /> Saved {relativeTime(savedAt)}</> : ""}
            </span>
            <Button size="sm" variant="ghost" icon={Save} onClick={() => void save()} disabled={!dirty || saving}>Save</Button>
            <Button size="sm" icon={Download} onClick={() => exportBoard({ ...draft, decisions, history })}>Export</Button>
            <Button size="sm" icon={RefreshCw} onClick={() => setConfirm({
              title: "Recompare with Spira?",
              body: "Each test set is reconciled again. Manual moves are kept for cases that are still present; cases that disappeared are dropped.",
              confirmLabel: "Recompare",
              run: () => void runRecompare(draft.testSetIds),
            })} disabled={!!recompare?.running}>Recompare</Button>
            <Button size="sm" icon={Bug} onClick={() => void findDefects()} disabled={!complete} title="Find the cases a defect affects, here and in other modules">Find defects</Button>
            {isCompleted(draft.status) ? (
              <>
                <Button size="sm" icon={ClipboardCheck} onClick={goToReview} disabled={!complete}>Review</Button>
                <ButtonLink href={`/drafts/${id}/execute`} size="sm" variant="primary" icon={Play}>Run execution</ButtonLink>
              </>
            ) : (
              <Button size="sm" variant="primary" icon={ClipboardCheck} onClick={goToReview} disabled={!complete}>Review &amp; apply</Button>
            )}
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
          {counts.needsReview} card{counts.needsReview === 1 ? "" : "s"} in Needs Review. Move each to In Scope, Defects, Blocked or Out of Scope before a live apply.
        </Notice>
      )}

      <dl className="surface grid grid-cols-2 gap-x-4 gap-y-5 px-5 py-5 sm:grid-cols-4 sm:px-6 xl:grid-cols-7">
        <Stat label="Total cards" value={counts.total} icon={Layers} />
        <Stat label="In Scope" value={counts.inScope} icon={CheckCircle2} tone="success" />
        <Stat label="Defects" value={counts.defects} icon={Bug} tone={counts.defects ? "violet" : undefined} hint="kept, run as Failed" />
        <Stat label="Blocked" value={counts.blocked} icon={Ban} tone={counts.blocked ? "orange" : undefined} hint="not implemented" />
        <Stat label="Out of Scope" value={counts.outOfScope} icon={MinusCircle} tone={counts.outOfScope ? "danger" : undefined} hint="to remove" />
        <Stat label="Needs Review" value={counts.needsReview} icon={CircleHelp} tone={counts.needsReview ? "warning" : undefined} />
        <Stat label="Missing from Spira" value={missingCount} icon={FileQuestion} />
      </dl>

      {complete && <KeywordPanel draft={draft} cards={cards} decisions={decisions} onDraft={adoptDraft} onApply={applyReview} />}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          {draft.testSets.length > 1 && (
            <div className="inline-flex w-fit max-w-full shrink-0 gap-1 overflow-x-auto overflow-y-hidden rounded-xl bg-slate-200/60 p-1 [scrollbar-width:none] dark:bg-white/[0.05]" role="tablist" aria-label="Test set">
              {[{ id: "all" as const, label: "All test sets" }, ...draft.testSets.map((s) => ({ id: s.testSetId, label: s.testSetName }))].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={setFilter === tab.id}
                  onClick={() => setSetFilter(tab.id)}
                  className={clsx(
                    "relative cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition",
                    setFilter === tab.id ? "text-slate-900 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                  )}
                >
                  {setFilter === tab.id && <motion.span layoutId="set-tab" className="absolute inset-0 rounded-lg bg-white shadow-soft dark:bg-white/[0.1]" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                  <span className="relative">{tab.label}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:max-w-xs sm:flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <input type="search" className="input pl-9" placeholder="Search name, TC ID or case ID" aria-label="Search cards" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="relative sm:w-52">
              <SlidersHorizontal className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <select className="input appearance-none pl-9" aria-label="Filter cards" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="all">All cards</option>
                <option value="executed">Executed</option>
                <option value="notExecuted">Not executed</option>
                <option value="manual">Moved manually</option>
                <option value="keyword">Mentions a keyword</option>
              </select>
            </div>
            <div className="flex items-center gap-1 sm:ml-auto">
              <Button size="sm" variant="ghost" icon={Undo2} onClick={undo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">Undo</Button>
              <Button size="sm" variant="ghost" icon={Redo2} onClick={redo} disabled={redoStack.length === 0} title="Redo (Ctrl+Y)">Redo</Button>
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={reset} disabled={Object.keys(decisions).length === 0}>Reset</Button>
            </div>
          </div>
        </div>
        <p className="hidden items-center gap-1.5 text-xs text-slate-500 lg:flex dark:text-zinc-500">
          <Keyboard className="size-3.5" aria-hidden />
          Click a card for its full details and test steps. Drag cards between columns, or focus a card and press <kbd className="kbd">Enter</kbd> to open, <kbd className="kbd">Space</kbd> to select, <kbd className="kbd">1</kbd> <kbd className="kbd">2</kbd> <kbd className="kbd">3</kbd> <kbd className="kbd">4</kbd> <kbd className="kbd">5</kbd> to move, <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to navigate.
        </p>
      </div>

      <AnimatePresence>
        {selection.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 24, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: 24, x: "-50%" }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="fixed bottom-6 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-max flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white/90 px-3 py-2.5 shadow-lift backdrop-blur-xl lg:ml-32 lg:rail:ml-8 dark:border-white/10 dark:bg-zinc-900/90"
          >
            <span className="rounded-lg bg-brand-600 px-2 py-1 text-xs font-semibold text-white tabular-nums">{selection.size}</span>
            <span className="text-sm font-medium">selected · move to</span>
            {COLUMNS.map((c) => {
              const Icon = COLUMN_STYLE[c].icon;
              return (
                <button key={c} type="button" onClick={() => move([...selection], c)} className={clsx("inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition hover:brightness-95", COLUMN_STYLE[c].chip)}>
                  <Icon className="size-3.5" aria-hidden />
                  {COLUMN_LABELS[c]}
                </button>
              );
            })}
            <Button size="sm" variant="ghost" icon={X} onClick={() => setSelection(new Set())}>Clear</Button>
          </motion.div>
        )}
      </AnimatePresence>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveDrag(null)}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
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
                  assessment={assessmentFor(card)}
                  moved={Boolean(decisions[card.key])}
                  selected={selection.has(card.key)}
                  onToggle={toggle}
                  onMove={moveOne}
                  onKey={onCardKey}
                  onOpen={openCard}
                />
              )}
            </BoardColumn>
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeCard && (
            <div className="max-w-xs rotate-2 rounded-xl border border-brand-400 bg-white p-3 text-sm font-medium shadow-lift dark:bg-zinc-900">
              {dragCount > 1 ? `${dragCount} cards` : activeCard.name}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <div className="grid gap-4 xl:grid-cols-2">
        <Collapsible title="Missing from Spira" count={missingCount} icon={FileQuestion} open={showMissing} onToggle={() => setShowMissing((v) => !v)}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-slate-500 dark:text-zinc-400"><tr><th className="px-5 py-2 font-medium">TC ID</th><th className="px-5 py-2 font-medium">Scenario</th><th className="px-5 py-2 font-medium">Test set</th><th className="px-5 py-2 font-medium">Reason</th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
                {draft.testSets.flatMap((s) => s.missingFromSpira.map((row, i) => (
                  <tr key={`${s.testSetId}-${i}`}><td className="px-5 py-2 font-mono text-xs">{row.tcId}</td><td className="px-5 py-2">{row.testScenario}</td><td className="px-5 py-2 text-slate-500">{s.testSetName}</td><td className="px-5 py-2 text-slate-500">{row.reason}</td></tr>
                )))}
                {missingCount === 0 && <tr><td colSpan={4} className="px-5 py-4 text-slate-500">Every workbook row has a matching Spira test case.</td></tr>}
              </tbody>
            </table>
          </div>
        </Collapsible>

        <Collapsible title="Change history" count={history.length} icon={History} open={showHistory} onToggle={() => setShowHistory((v) => !v)}>
          <ol className="relative mx-5 mb-4 border-l border-slate-200 text-sm dark:border-white/10">
            {[...history].reverse().slice(0, 200).map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="relative py-2 pl-5">
                <span className="absolute top-3.5 -left-[5px] size-2.5 rounded-full border-2 border-white bg-brand-500 dark:border-zinc-900" />
                <span className="block text-xs text-slate-500 dark:text-zinc-500">{formatDateTime(entry.at)}</span>
                <span>{entry.label}</span>
              </li>
            ))}
            {history.length === 0 && <li className="py-2 pl-5 text-slate-500">No changes yet.</li>}
          </ol>
        </Collapsible>
      </div>

      <CardDetail
        card={detailCard}
        draft={draft}
        column={detailColumn}
        moved={detailCard ? Boolean(decisions[detailCard.key]) : false}
        keywords={detailCard ? hits.get(detailCard.key) : undefined}
        assessment={detailCard ? assessmentFor(detailCard) : null}
        position={detailIndex >= 0 ? { index: detailIndex, total: detailList.length } : null}
        onClose={() => setOpenKey(null)}
        onMove={(key, to) => move([key], to)}
        onPrev={neighbour(-1)}
        onNext={neighbour(1)}
      />

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
