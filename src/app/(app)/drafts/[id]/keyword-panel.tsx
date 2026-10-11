"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Notice, ProgressBar } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { mutateDraft } from "@/lib/client/drafts";
import { readTestSteps } from "@/lib/client/workflow";
import { chunk, effectiveColumn, MAX_APPLY_BATCH } from "@/lib/domain/board";
import { draftKeywords, hasKeywords, normalizeKeywords, parseKeywords } from "@/lib/domain/keywords";
import type { Card, Column, Draft } from "@/lib/domain/types";

type Scan = { running: boolean; done: number; total: number; message: string | null; error: string | null };

/**
 * Keywords for features that are not built yet: one list for every test set, plus a list
 * per test set. Checking reads the steps of every case that is not Out of Scope, then moves
 * In Scope cases that mention a keyword for their test set to Blocked.
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
  const anyKeywords = hasKeywords(draftKeywords(draft));

  const unreadIds = (d: Draft) => [
    ...new Set(
      cards
        .filter((c) => effectiveColumn(c, decisions) !== "outOfScope" && !(String(c.testCaseId) in (d.stepText ?? {})))
        .map((c) => c.testCaseId),
    ),
  ];
  const checkable = new Set(cards.filter((c) => effectiveColumn(c, decisions) !== "outOfScope").map((c) => c.testCaseId)).size;
  const unread = unreadIds(draft).length;

  function saveAll(next: string[]) {
    onDraft(mutateDraft(draft.id, (d) => void (d.keywords = normalizeKeywords(next))));
  }

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

  async function check(auto: boolean) {
    let latest = draft;
    const ids = unreadIds(draft);
    const failed: string[] = [];
    setScan({ running: true, done: 0, total: ids.length, message: null, error: null });
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
    const moved = onBlockMatches(latest);
    if (auto) onDraft(mutateDraft(draft.id, (d) => void (d.keywordsAppliedAt = new Date().toISOString())));
    setScan({
      running: false,
      done: ids.length,
      total: ids.length,
      message: moved
        ? `Moved ${moved} In Scope case${moved === 1 ? "" : "s"} to Blocked. Undo puts them back.`
        : "No In Scope case mentions these keywords.",
      error: failed.length ? `The steps of ${failed.length} case${failed.length === 1 ? "" : "s"} could not be read: ${failed[0]}` : null,
    });
  }

  // A draft with keywords is checked once automatically when the board opens.
  const autoStarted = useRef(false);
  const autoCheck = anyKeywords && !draft.keywordsAppliedAt && draft.testSets.length > 0;
  useEffect(() => {
    if (!autoCheck || autoStarted.current) return;
    const timer = window.setTimeout(() => {
      autoStarted.current = true;
      void check(true);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck]);

  return (
    <section className="surface flex flex-col gap-3 px-5 py-4" aria-labelledby="keywords-title">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="keywords-title" className="font-semibold">Not implemented yet</h2>
          <p className="text-sm text-zinc-500">
            In Scope cases whose name, description or steps mention a keyword for their test set move to Blocked. When you approve the draft they are recorded in Spira as Blocked.
          </p>
        </div>
        <Button size="sm" className="shrink-0" onClick={() => void check(false)} disabled={!anyKeywords || !!scan?.running} busy={scan?.running}>
          {pending > 0 ? `Move ${pending} to Blocked` : unread > 0 ? "Read steps and check" : "Check again"}
        </Button>
      </div>

      <dl className="flex flex-col divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        <KeywordRow label="Every test set" keywords={draft.keywords ?? []} onChange={saveAll} />
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

      {anyKeywords && !scan?.running && (
        <p className="text-xs text-zinc-500">
          Steps read for {checkable - unread} of {checkable} case{checkable === 1 ? "" : "s"} that are not Out of Scope. Keywords match whole words, so “nin” does not match “running”.
        </p>
      )}
      {scan?.running && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-500">Reading test steps from Spira… {scan.done} / {scan.total}</span>
          <ProgressBar value={scan.done} max={Math.max(scan.total, 1)} />
        </div>
      )}
      {scan?.message && !scan.running && <Notice tone="success">{scan.message}</Notice>}
      {scan?.error && !scan.running && <Notice tone="warning" title="Some steps were not read">{scan.error}</Notice>}
    </section>
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
