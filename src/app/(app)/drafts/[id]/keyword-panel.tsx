"use client";

import clsx from "clsx";
import {
  ArrowRight,
  BarChart3,
  ChevronDown,
  Filter,
  Loader2,
  RefreshCw,
  ScanSearch,
  Square,
  Tag,
  UserCheck,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, Notice, ProgressBar } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { mutateDraft } from "@/lib/client/drafts";
import { reviewBlockedCases } from "@/lib/client/workflow";
import {
  blockedCandidates,
  blockedProposals,
  deepCandidates,
  defaultSelection,
  hasCurrentAiVerdict,
  hasCurrentDeepVerdict,
  hasKeywords,
  keywordsFor,
  keywordReport,
  normalizeKeywords,
  parseKeywords,
  type BlockedProposal,
  type KeywordReportRow,
} from "@/lib/domain/keywords";
import { COLUMN_LABELS, type Card, type Column, type Draft } from "@/lib/domain/types";
import { AssessmentBadge, COLUMN_STYLE } from "./board-parts";

type Scan = { done: number; total: number; ai: boolean; deep: boolean };
type View = "changes" | "blocked" | "notBlocked" | "all";

const REPORT_COLUMNS: Column[] = ["inScope", "blocked", "needsReview", "outOfScope"];

/**
 * Not-implemented features, one keyword list per test set in the draft. Filter finds In Scope and Blocked
 * cases whose test scenario mentions a keyword, has the AI judge whether each really depends on the
 * feature, and lists the suggested moves for the user to accept. Nothing moves without the user.
 */
export function KeywordPanel({
  draft,
  cards,
  decisions,
  onDraft,
  onApply,
}: {
  draft: Draft;
  cards: Card[];
  decisions: Record<string, Column>;
  onDraft: (draft: Draft) => void;
  /** Moves the selected proposals; returns how many went to Blocked and back to In Scope. */
  onApply: (proposals: BlockedProposal[], selected: Set<string>) => { toBlocked: number; toInScope: number };
}) {
  const { ai } = useSettings();
  const aiOn = !!ai?.configured;
  const [scan, setScan] = useState<Scan | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>("changes");
  const [showReport, setShowReport] = useState(false);
  const anyKeywords = hasKeywords(draft.testSetKeywords);
  const filteredAt = draft.keywordsFilteredAt ? new Date(draft.keywordsFilteredAt) : null;

  const proposals = useMemo(
    () => blockedProposals(cards, decisions, draft.testSetKeywords, draft.blockedReview),
    [cards, decisions, draft.testSetKeywords, draft.blockedReview],
  );
  const report = useMemo(() => keywordReport(cards, decisions, draft.testSetKeywords), [cards, decisions, draft.testSetKeywords]);

  const changes = proposals.filter((p) => p.proposed !== p.current && (p.kind === "noKeyword" || p.assessment));
  const changeKeys = new Set(changes.map((p) => p.card.key));
  const chosen = new Set([...selected].filter((k) => changeKeys.has(k)));
  const unanalysed = proposals.filter((p) => p.kind === "match" && !p.assessment).length;
  const lowConfidence = changes.filter((p) => p.assessment?.confidence === "low").length;
  const deepPending = useMemo(
    () =>
      deepCandidates(cards, decisions, draft.testSetKeywords).filter(
        (c) => !hasCurrentDeepVerdict(draft.blockedReview?.[c.card.key], keywordsFor(draft.testSetKeywords, c.card.testSetId)),
      ),
    [cards, decisions, draft.testSetKeywords, draft.blockedReview],
  );
  const stopRef = useRef<AbortController | null>(null);

  const visible = proposals.filter((p) => {
    if (view === "changes") return changeKeys.has(p.card.key);
    if (view === "blocked") return p.kind !== "noKeyword" && p.assessment?.blocked;
    if (view === "notBlocked") return p.kind === "noKeyword" || (p.assessment && !p.assessment.blocked);
    return true;
  });

  function saveForSet(testSetId: number, next: string[]) {
    onDraft(
      mutateDraft(draft.id, (d) => {
        const lists = { ...(d.testSetKeywords ?? {}) };
        const clean = normalizeKeywords(next);
        if (clean.length) lists[String(testSetId)] = clean;
        else delete lists[String(testSetId)];
        d.testSetKeywords = lists;
      }),
    );
  }

  async function filter(force: boolean) {
    const candidates = blockedCandidates(cards, decisions, draft.testSetKeywords);
    const toAnalyse = aiOn && !force ? candidates.filter((c) => !hasCurrentAiVerdict(draft.blockedReview?.[c.card.key], c.keywords)) : candidates;
    await run(toAnalyse, aiOn, false, candidates.length);
  }

  async function deepCheck() {
    if (!aiOn || deepPending.length === 0) return;
    await run(deepPending, true, true, deepPending.length);
  }

  async function run(toAnalyse: typeof deepPending, useAi: boolean, deep: boolean, checked: number) {
    const controller = new AbortController();
    stopRef.current = controller;
    setAiError(null);
    setScan({ done: 0, total: toAnalyse.length, ai: useAi, deep });
    try {
      const out = await reviewBlockedCases(draft.id, toAnalyse, useAi, (done, total) => setScan({ done, total, ai: true, deep }), controller.signal);
      onDraft(out.draft);
      setAiError(out.aiError);
      const next = blockedProposals(cards, decisions, out.draft.testSetKeywords, out.draft.blockedReview);
      setSelected(defaultSelection(next));
      setView("changes");
      const suggested = next.filter((p) => p.proposed !== p.current && p.assessment).length;
      const description = suggested ? `${suggested} suggested change${suggested === 1 ? "" : "s"} to review.` : "Nothing needs to move.";
      if (out.aiError) toast.warning(deep ? "Deep check stopped early." : "AI review stopped early.", { description: out.aiError });
      else if (out.stopped) toast.info("Stopped. Answers so far are kept.", { description });
      else if (deep) toast.success(`Deep-checked ${checked} case${checked === 1 ? "" : "s"}`, { description });
      else toast.success(`Checked ${checked} matching case${checked === 1 ? "" : "s"}`, { description });
    } catch (err) {
      setAiError(errorMessage(err));
    } finally {
      stopRef.current = null;
      setScan(null);
    }
  }

  function apply() {
    const { toBlocked, toInScope } = onApply(proposals, chosen);
    setSelected(new Set());
    const parts = [toBlocked && `${toBlocked} to Blocked`, toInScope && `${toInScope} back to In Scope`].filter(Boolean);
    if (parts.length) toast.success(`Moved ${parts.join(" and ")}`, { description: "Undo with Ctrl+Z." });
  }

  const toggle = (key: string) =>
    setSelected((s) => {
      const next = new Set([...s].filter((k) => changeKeys.has(k)));
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const counts = {
    changes: changes.length,
    blocked: proposals.filter((p) => p.kind !== "noKeyword" && p.assessment?.blocked).length,
    notBlocked: proposals.filter((p) => p.kind === "noKeyword" || (p.assessment && !p.assessment.blocked)).length,
    all: proposals.length,
  };

  return (
    <section className="surface overflow-hidden" aria-labelledby="keywords-title">
      <div className="border-b border-slate-100 px-5 py-5 sm:px-6 dark:border-white/[0.06]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="keywords-title" className="text-base font-semibold tracking-tight">Not implemented yet</h2>
              {ai && <Badge>{aiOn ? `Reviewed by ${ai.model}` : "Keyword match only"}</Badge>}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600 dark:text-zinc-400">
              Add keywords for features that are not built yet. Filter checks only the <strong className="font-medium text-slate-800 dark:text-zinc-200">test scenario</strong>{" "}
              (the Spira name and the workbook scenario), never steps or test data.{" "}
              {aiOn
                ? "Gemini then judges whether each matching case really depends on the feature, and you choose which suggestions to apply. Deep check also asks about cases whose scenario names no keyword."
                : "Every match is suggested as Blocked for you to review. Add GEMINI_API_KEY on the server to have the AI judge each case."}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {filteredAt && aiOn && (
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void filter(true)} disabled={!anyKeywords || !!scan} title="Ask the AI again about every matching case">
                Re-analyse all
              </Button>
            )}
            {aiOn && (
              <Button
                variant="secondary"
                icon={ScanSearch}
                onClick={() => void deepCheck()}
                disabled={!anyKeywords || !!scan || deepPending.length === 0}
                title={
                  deepPending.length
                    ? `Ask the AI about ${deepPending.length} In Scope or Blocked case${deepPending.length === 1 ? "" : "s"} whose scenario names no keyword, in case they depend on a missing feature anyway`
                    : "Every case without a keyword has been deep-checked against the current keywords"
                }
              >
                Deep check{deepPending.length ? ` (${deepPending.length})` : ""}
              </Button>
            )}
            <Button variant="primary" icon={Filter} onClick={() => void filter(false)} disabled={!anyKeywords || !!scan} busy={!!scan && !scan.deep}>
              Filter
            </Button>
          </div>
        </div>
      </div>

      <dl className="divide-y divide-slate-100 dark:divide-white/[0.05]">
        {draft.testSets.map((set) => (
          <KeywordRow
            key={set.testSetId}
            label={set.testSetName}
            sublabel={`TX${set.testSetId} · ${set.platform}`}
            keywords={draft.testSetKeywords?.[String(set.testSetId)] ?? []}
            onChange={(next) => saveForSet(set.testSetId, next)}
          />
        ))}
      </dl>

      <AnimatePresence initial={false}>
        {scan && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-2 border-t border-slate-100 px-5 py-4 sm:px-6 dark:border-white/[0.06]">
              <span className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400">
                <Loader2 className="size-4 animate-spin text-slate-400" aria-hidden />
                {scan.ai
                  ? `${scan.deep ? "Deep-checking scenarios without a keyword" : "Reviewing matching scenarios"}… ${scan.done} / ${scan.total}`
                  : "Matching keywords against the scenarios…"}
                {scan.ai && (
                  <button
                    type="button"
                    className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white"
                    onClick={() => stopRef.current?.abort()}
                  >
                    <Square className="size-3 fill-current" aria-hidden /> Stop
                  </button>
                )}
              </span>
              <ProgressBar value={scan.ai ? scan.done : 1} max={Math.max(scan.ai ? scan.total : 1, 1)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {aiError && !scan && (
        <div className="border-t border-slate-100 px-5 py-4 sm:px-6 dark:border-white/[0.06]">
          <Notice tone="warning" title="The AI review did not finish">
            {aiError} Answers received so far are kept. Matching cases it did not answer use the keyword match until you press Filter again.
          </Notice>
        </div>
      )}

      {anyKeywords && filteredAt && !scan && (
        <div className="border-t border-slate-100 dark:border-white/[0.06]">
          <div className="flex flex-col gap-3 px-5 pt-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
            <div role="tablist" aria-label="Suggestions" className="inline-flex w-fit flex-wrap gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/[0.05]">
              {(
                [
                  ["changes", "Suggested changes"],
                  ["blocked", "Blocked"],
                  ["notBlocked", "Not blocked"],
                  ["all", "All matches"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  onClick={() => setView(id)}
                  className={clsx(
                    "relative cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium transition",
                    view === id ? "text-slate-900 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200",
                  )}
                >
                  {view === id && <motion.span layoutId="kw-tab" className="absolute inset-0 rounded-lg bg-white shadow-soft dark:bg-white/[0.1]" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                  <span className="relative">
                    {label} <span className="tabular-nums opacity-60">{counts[id]}</span>
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-500">
              Last filtered {filteredAt.toLocaleString()}
              {unanalysed > 0 && <> · {unanalysed} not analysed yet (keywords changed), press Filter</>}
            </p>
          </div>

          <ul className="mt-3 flex max-h-[28rem] flex-col overflow-y-auto px-2 pb-2 sm:px-3">
            {visible.map((p) => (
              <ProposalRow key={p.card.key} proposal={p} changing={changeKeys.has(p.card.key)} checked={chosen.has(p.card.key)} onToggle={toggle} setName={draft.testSets.length > 1 ? draft.testSets.find((s) => s.testSetId === p.card.testSetId)?.testSetName ?? null : null} />
            ))}
            {visible.length === 0 && (
              <li className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-slate-500 dark:text-zinc-500">
                <UserCheck className="size-6 opacity-60" aria-hidden />
                {view === "changes" ? "Nothing to change: every matching case is already where the review suggests." : "No cases in this view."}
              </li>
            )}
          </ul>

          {changes.length > 0 && (
            <div className="sticky bottom-0 flex flex-col gap-3 border-t border-slate-100 bg-white/90 px-5 py-3.5 backdrop-blur sm:flex-row sm:items-center sm:px-6 dark:border-white/[0.06] dark:bg-zinc-900/90">
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                <span className="font-semibold text-slate-900 tabular-nums dark:text-white">{chosen.size}</span> of {changes.length} suggested change{changes.length === 1 ? "" : "s"} selected
                {lowConfidence > 0 && <span className="text-amber-700 dark:text-amber-400"> · {lowConfidence} low-confidence, left for you to decide</span>}
              </p>
              <div className="flex gap-2 sm:ml-auto">
                <Button size="sm" variant="ghost" onClick={() => setSelected(chosen.size ? new Set() : new Set(changeKeys))}>
                  {chosen.size ? "Clear" : "Select all"}
                </Button>
                <Button size="sm" variant="primary" icon={ArrowRight} onClick={apply} disabled={chosen.size === 0}>
                  Apply {chosen.size || ""} change{chosen.size === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          )}

          <div className="border-t border-slate-100 dark:border-white/[0.06]">
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 px-5 py-3 text-left text-sm font-medium text-slate-600 transition hover:text-slate-900 sm:px-6 dark:text-zinc-400 dark:hover:text-white"
              aria-expanded={showReport}
              onClick={() => setShowReport((v) => !v)}
            >
              <BarChart3 className="size-4" aria-hidden />
              Where each keyword appears
              <ChevronDown className={clsx("ml-auto size-4 transition-transform", showReport && "rotate-180")} aria-hidden />
            </button>
            <AnimatePresence initial={false}>
              {showReport && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <KeywordReport rows={report} draft={draft} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}

      {anyKeywords && !filteredAt && !scan && (
        <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500 sm:px-6 dark:border-white/[0.06] dark:text-zinc-500">
          Press <strong className="font-medium text-slate-700 dark:text-zinc-300">Filter</strong> to find the cases these keywords affect.
        </p>
      )}
    </section>
  );
}

function ProposalRow({
  proposal: p,
  changing,
  checked,
  onToggle,
  setName,
}: {
  proposal: BlockedProposal;
  changing: boolean;
  checked: boolean;
  onToggle: (key: string) => void;
  setName: string | null;
}) {
  const from = COLUMN_STYLE[p.current];
  const to = COLUMN_STYLE[p.proposed];
  const reason = p.kind === "noKeyword" ? "Blocked, but its test scenario mentions none of the keywords." : p.assessment?.reason ?? "Not analysed for its current keywords yet.";
  const inferred = p.kind === "deep" ? (p.assessment?.features ?? []) : [];
  return (
    <li>
      <label
        className={clsx(
          "flex gap-3 rounded-xl px-3 py-3 transition",
          changing ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-white/[0.03]" : "opacity-80",
          checked && "bg-brand-50/60 hover:bg-brand-50 dark:bg-brand-500/[0.07] dark:hover:bg-brand-500/10",
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-brand-600 disabled:cursor-default disabled:opacity-30"
          checked={checked}
          disabled={!changing}
          onChange={() => onToggle(p.card.key)}
          aria-label={`Move ${p.card.name} to ${COLUMN_LABELS[p.proposed]}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <span className="min-w-0 text-sm leading-snug font-medium text-slate-800 dark:text-zinc-100">{p.card.name}</span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium">
              <span className={clsx("rounded-full px-2 py-0.5 ring-1 ring-inset", from.chip)}>{COLUMN_LABELS[p.current]}</span>
              {changing && (
                <>
                  <ArrowRight className="size-3 text-slate-400" aria-hidden />
                  <span className={clsx("rounded-full px-2 py-0.5 ring-1 ring-inset", to.chip)}>{COLUMN_LABELS[p.proposed]}</span>
                </>
              )}
            </span>
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-zinc-500">
            <span className="font-mono">TC{p.card.testCaseId}</span>
            {setName && <span>· {setName}</span>}
            {p.keywords.map((k) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700 dark:bg-white/[0.06] dark:text-zinc-300">
                <Tag className="size-3" aria-hidden />
                {k}
              </span>
            ))}
            {p.kind === "deep" && (
              <span className="rounded-full border border-dashed border-slate-300 px-1.5 py-0.5 font-medium text-slate-600 dark:border-white/15 dark:text-zinc-400" title="Found by deep check: the scenario does not name the keyword">
                Deep check{inferred.length ? `: ${inferred.join(", ")}` : ""}
              </span>
            )}
            {p.assessment && <AssessmentBadge assessment={p.assessment} />}
            {p.assessment?.confidence === "low" && <Badge tone="warning">Your call</Badge>}
          </span>
          <span className="mt-1.5 block text-xs leading-relaxed text-slate-600 dark:text-zinc-400">{reason}</span>
        </span>
      </label>
    </li>
  );
}

function KeywordReport({ rows, draft }: { rows: KeywordReportRow[]; draft: Draft }) {
  const setName = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `TX${id}`;
  const multipleSets = new Set(rows.map((r) => r.testSetId)).size > 1;
  return (
    <div className="px-5 pb-5 sm:px-6">
      <div className="overflow-x-auto rounded-xl border border-slate-200/80 dark:border-white/[0.06]">
        <table className="w-full text-sm">
          <caption className="sr-only">Where each keyword appears in test scenarios</caption>
          <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-white/[0.03] dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 font-medium">Keyword</th>
              {REPORT_COLUMNS.map((c) => (
                <th key={c} className="px-3 py-2 text-right font-medium">
                  {COLUMN_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/[0.05]">
            {rows.map((row) => (
              <tr key={`${row.testSetId}:${row.keyword}`}>
                <td className="px-3 py-2 font-medium">
                  {row.keyword}
                  {multipleSets && <span className="ml-2 text-xs font-normal text-slate-500">{setName(row.testSetId)}</span>}
                </td>
                {REPORT_COLUMNS.map((c) => (
                  <td key={c} className="px-3 py-2 text-right tabular-nums">
                    {row.byColumn[c].length || <span className="text-slate-300 dark:text-zinc-600">0</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-zinc-500">
        Counts cases whose test scenario mentions the keyword as a whole word or its plural, ignoring case. A keyword found only in Out of Scope means the workbook left those cases out.
      </p>
    </div>
  );
}

function KeywordRow({
  label,
  sublabel,
  keywords,
  onChange,
}: {
  label: string;
  sublabel?: string;
  keywords: string[];
  onChange: (next: string[]) => void;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const added = parseKeywords(text);
    if (added.length) onChange([...keywords, ...added]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2.5 px-5 py-3.5 sm:flex-row sm:items-center sm:px-6">
      <dt className="text-sm sm:w-52 sm:shrink-0">
        <span className="font-medium">{label}</span>
        {sublabel && <span className="block text-xs text-slate-500 dark:text-zinc-500">{sublabel}</span>}
      </dt>
      <dd className="flex min-h-10 flex-1 flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1.5 transition focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15 dark:border-white/10 dark:bg-zinc-950/60">
        <AnimatePresence initial={false}>
          {keywords.map((k) => (
            <motion.span
              key={k}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              className="inline-flex items-center gap-1 rounded-lg bg-orange-50 py-1 pr-1 pl-2 text-xs font-medium text-orange-800 ring-1 ring-orange-200/70 ring-inset dark:bg-orange-500/10 dark:text-orange-200 dark:ring-orange-400/20"
            >
              {k}
              <button
                type="button"
                className="grid size-4 cursor-pointer place-items-center rounded hover:bg-orange-200/70 dark:hover:bg-orange-400/20"
                aria-label={`Remove keyword ${k} from ${label}`}
                onClick={() => onChange(keywords.filter((x) => x !== k))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-zinc-500"
          placeholder={keywords.length ? "Add more…" : "Type a feature, e.g. nin, bvn, google — press Enter"}
          aria-label={`Add keywords for ${label}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !text && keywords.length) {
              onChange(keywords.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      </dd>
    </div>
  );
}
