"use client";

import { useMemo, useState } from "react";
import { Button, Notice, ProgressBar } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { mutateDraft } from "@/lib/client/drafts";
import { readTestSteps } from "@/lib/client/workflow";
import { chunk, MAX_APPLY_BATCH } from "@/lib/domain/board";
import { hasKeywords, keywordReport, normalizeKeywords, parseKeywords, type KeywordReportRow } from "@/lib/domain/keywords";
import { COLUMN_LABELS, type Card, type Column, type Draft } from "@/lib/domain/types";

type Scan = { running: boolean; done: number; total: number; moved: number | null; error: string | null };

const REPORT_COLUMNS: Column[] = ["inScope", "blocked", "needsReview", "outOfScope"];

/**
 * Keywords for features that are not built yet, one list per test set in the draft.
 * Filter reads the steps of every case from Spira again, then moves In Scope cases that
 * mention a keyword for their test set to Blocked and reports where every keyword was found.
 */
export function KeywordPanel({
  draft,
  cards,
  decisions,
  pending,
  onDraft,
  onBlockMatches,
}: {
  draft: Draft;
  cards: Card[];
  decisions: Record<string, Column>;
  /** In Scope cards that mention a keyword. */
  pending: number;
  onDraft: (draft: Draft) => void;
  /** Moves matching In Scope cards to Blocked and returns how many moved. */
  onBlockMatches: (draft: Draft) => number;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const anyKeywords = hasKeywords(draft.testSetKeywords);
  const report = useMemo(
    () => keywordReport(cards, decisions, draft.testSetKeywords, draft.stepText),
    [cards, decisions, draft.testSetKeywords, draft.stepText],
  );

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

  async function filter() {
    const setIds = new Set(Object.keys(draft.testSetKeywords ?? {}).filter((id) => draft.testSetKeywords![id].length > 0));
    const ids = [...new Set(cards.filter((c) => setIds.has(String(c.testSetId))).map((c) => c.testCaseId))];
    let latest = draft;
    const failed: string[] = [];
    setScan({ running: true, done: 0, total: ids.length, moved: null, error: null });
    try {
      for (const batch of chunk(ids, MAX_APPLY_BATCH)) {
        const out = await readTestSteps(draft.id, batch);
        latest = out.draft;
        onDraft(latest);
        failed.push(...Object.values(out.failed));
        setScan((s) => s && { ...s, done: s.done + batch.length });
      }
    } catch (err) {
      setScan((s) => s && { ...s, running: false, error: errorMessage(err) });
      return;
    }
    latest = mutateDraft(draft.id, (d) => void (d.keywordsFilteredAt = new Date().toISOString()));
    onDraft(latest);
    const moved = onBlockMatches(latest);
    setScan({
      running: false,
      done: ids.length,
      total: ids.length,
      moved,
      error: failed.length
        ? `The steps of ${failed.length} case${failed.length === 1 ? "" : "s"} could not be read, so only their name, description and workbook row were checked: ${failed[0]}`
        : null,
    });
  }

  const filteredAt = draft.keywordsFilteredAt ? new Date(draft.keywordsFilteredAt) : null;

  return (
    <section className="surface flex flex-col gap-3 px-5 py-4" aria-labelledby="keywords-title">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="keywords-title" className="font-semibold">Not implemented yet</h2>
          <p className="text-sm text-zinc-500">
            Add keywords for features that are not built yet. Filter checks every case in the test set: its name, description and custom fields in Spira, all of its
            steps (including steps from linked test cases), and its row in your workbook. In Scope cases that mention a keyword move to Blocked.
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => void filter()} disabled={!anyKeywords || !!scan?.running} busy={scan?.running}>
          Filter
        </Button>
      </div>

      <dl className="flex flex-col divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
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

      {scan?.running && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-500">Reading test steps from Spira… {scan.done} / {scan.total} cases</span>
          <ProgressBar value={scan.done} max={Math.max(scan.total, 1)} />
        </div>
      )}
      {scan?.moved !== null && scan?.moved !== undefined && !scan.running && (
        <Notice tone={scan.moved ? "success" : "info"}>
          {scan.moved
            ? `Checked ${scan.total} cases. Moved ${scan.moved} In Scope case${scan.moved === 1 ? "" : "s"} to Blocked; Undo puts them back.`
            : `Checked ${scan.total} cases. No In Scope case mentions these keywords; the table below shows where each keyword was found.`}
        </Notice>
      )}
      {scan?.error && !scan.running && <Notice tone="warning" title="Some steps were not read">{scan.error}</Notice>}
      {!scan?.running && pending > 0 && filteredAt && (
        <Notice tone="warning">
          {pending} In Scope case{pending === 1 ? "" : "s"} mention{pending === 1 ? "s" : ""} a keyword. Filter again to move {pending === 1 ? "it" : "them"} to Blocked.
        </Notice>
      )}

      {anyKeywords && filteredAt && !scan?.running && <KeywordReport rows={report} draft={draft} filteredAt={filteredAt} />}
      {anyKeywords && !filteredAt && !scan?.running && <p className="text-xs text-zinc-500">Press Filter to check the cases against these keywords.</p>}
    </section>
  );
}

function KeywordReport({ rows, draft, filteredAt }: { rows: KeywordReportRow[]; draft: Draft; filteredAt: Date }) {
  const setName = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `TX${id}`;
  const multipleSets = new Set(rows.map((r) => r.testSetId)).size > 1;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <caption className="sr-only">Where each keyword was found</caption>
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Keyword</th>
              {REPORT_COLUMNS.map((c) => (
                <th key={c} className="px-3 py-2 text-right font-medium">
                  {COLUMN_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((row) => (
              <KeywordReportLine key={`${row.testSetId}:${row.keyword}`} row={row} setLabel={multipleSets ? setName(row.testSetId) : null} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">
        Steps last read from Spira {filteredAt.toLocaleString()}. Keywords match whole words and their plural, ignoring case, so “nin” matches “NIN” and “NINs” but not
        “running”. Select a keyword to see its cases.
      </p>
    </div>
  );
}

function KeywordReportLine({ row, setLabel }: { row: KeywordReportRow; setLabel: string | null }) {
  const [open, setOpen] = useState(false);
  const total = REPORT_COLUMNS.reduce((n, c) => n + row.byColumn[c].length, 0);
  return (
    <>
      <tr>
        <td className="px-3 py-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 font-medium hover:underline disabled:no-underline"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            disabled={total === 0}
          >
            <span aria-hidden className="w-3 text-zinc-400">{total ? (open ? "▾" : "▸") : ""}</span>
            {row.keyword}
          </button>
          {setLabel && <span className="ml-2 text-xs text-zinc-500">{setLabel}</span>}
          {total === 0 && <span className="ml-2 text-xs text-zinc-500">not found in any case</span>}
        </td>
        {REPORT_COLUMNS.map((c) => (
          <td key={c} className="px-3 py-2 text-right tabular-nums">
            {row.byColumn[c].length || <span className="text-zinc-400">0</span>}
          </td>
        ))}
      </tr>
      {open && (
        <tr>
          <td colSpan={REPORT_COLUMNS.length + 1} className="bg-zinc-50/60 px-3 py-2 dark:bg-zinc-900/40">
            <div className="flex flex-col gap-2">
              {REPORT_COLUMNS.filter((c) => row.byColumn[c].length > 0).map((c) => (
                <div key={c}>
                  <div className="text-xs font-medium text-zinc-500">{COLUMN_LABELS[c]}</div>
                  <ul className="mt-0.5 flex flex-col gap-0.5 text-xs">
                    {row.byColumn[c].map((card) => (
                      <li key={card.key}>
                        <span className="font-mono text-zinc-500">TC{card.testCaseId}</span> {card.name}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
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
    <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
      <dt className="text-sm sm:w-56 sm:shrink-0">
        <span className="font-medium">{label}</span>
        {sublabel && <span className="block text-xs text-zinc-500">{sublabel}</span>}
      </dt>
      <dd className="flex flex-1 flex-wrap items-center gap-1.5">
        {keywords.map((k) => (
          <span key={k} className="inline-flex items-center gap-1 rounded-full bg-orange-50 py-0.5 pr-1 pl-2.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-200">
            {k}
            <button
              type="button"
              className="grid size-4 place-items-center rounded-full hover:bg-orange-200 dark:hover:bg-orange-800"
              aria-label={`Remove keyword ${k} from ${label}`}
              onClick={() => onChange(keywords.filter((x) => x !== k))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="input h-7 w-48 py-0 text-xs"
          placeholder={keywords.length ? "Add more" : "e.g. nin, bvn, google"}
          aria-label={`Add keywords for ${label}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </dd>
    </div>
  );
}
