"use client";

import clsx from "clsx";
import { ArrowRight, CircleCheckBig, Copy, FolderOpen, KanbanSquare, Pencil, Play, Plus, Search, Smartphone, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { deleteDraft, duplicateDraft, listDrafts, renameDraft } from "@/lib/client/drafts";
import { relativeTime, STATUS_LABEL, STATUS_TONE } from "@/lib/client/format";
import { completeWithoutChanges } from "@/lib/client/workflow";
import { isCompleted } from "@/lib/domain/board";
import { pushTarget } from "@/lib/domain/mirror";
import { isUatDraftId } from "@/lib/domain/uat-build";
import { COLUMN_LABELS, COLUMNS, type DraftSummary } from "@/lib/domain/types";

type Pending = { kind: "rename" | "delete"; draft: DraftSummary } | null;

const SCOPE_COLOR: Record<(typeof COLUMNS)[number], string> = {
  inScope: "bg-emerald-500",
  defects: "bg-violet-500",
  blocked: "bg-orange-500",
  outOfScope: "bg-slate-400 dark:bg-zinc-500",
  needsReview: "bg-amber-400",
};

function ScopeBar({ counts }: { counts: DraftSummary["counts"] }) {
  const total = COLUMNS.reduce((n, c) => n + counts[c], 0);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]" aria-hidden>
        {total > 0 && COLUMNS.map((c) => counts[c] > 0 && <span key={c} className={SCOPE_COLOR[c]} style={{ width: `${(counts[c] / total) * 100}%` }} />)}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs sm:grid-cols-5">
        {COLUMNS.map((c) => (
          <div key={c} className="min-w-0">
            <dt className="flex items-center gap-1.5 truncate text-slate-500 dark:text-zinc-400">
              <span className={clsx("size-1.5 shrink-0 rounded-full", SCOPE_COLOR[c])} />
              {COLUMN_LABELS[c]}
            </dt>
            <dd className={clsx("mt-0.5 text-sm font-semibold tabular-nums", c === "needsReview" && counts[c] > 0 && "text-amber-600 dark:text-amber-400")}>{counts[c]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** On a completed draft: push its cases and results to the other platform, or follow the copy already started. */
function PushRow({ draft, copy }: { draft: DraftSummary; copy: DraftSummary | null }) {
  const to = pushTarget(draft.platforms);
  if (!to) return null;
  const status = !copy
    ? `Same cases and results on ${to}`
    : !isCompleted(copy.status)
      ? `${to} test sets being matched`
      : copy.execution
        ? `${copy.execution.executed} / ${copy.execution.total} executed on ${to}`
        : `${to} test sets match`;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-slate-200 px-3 py-2.5 dark:border-white/10">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-500 dark:text-zinc-400">{to}</p>
        <p className="truncate text-sm font-semibold tabular-nums">{status}</p>
      </div>
      <ButtonLink href={`/drafts/${draft.id}/push`} size="sm" icon={Smartphone}>
        {copy ? "Continue" : `Push to ${to}`}
      </ButtonLink>
    </div>
  );
}

type Bucket = "drafts" | "completed";

/** Completion checks already run in this browser session, so a draft is checked once per version. */
const CHECKS_KEY = "srs:completion-checks";
type CheckRecord = { updatedAt: string; message: string | null };

function readChecks(): Record<string, CheckRecord> {
  try {
    return JSON.parse(sessionStorage.getItem(CHECKS_KEY) ?? "{}") as Record<string, CheckRecord>;
  } catch {
    return {};
  }
}

function saveCheck(id: string, record: CheckRecord) {
  try {
    sessionStorage.setItem(CHECKS_KEY, JSON.stringify({ ...readChecks(), [id]: record }));
  } catch {
    // Without the record the draft is simply checked again next time.
  }
}

const CHECK_CONCURRENCY = 2;

const BUCKET_TEXT: Record<Bucket, { title: string; description: string; search: string }> = {
  drafts: {
    title: "Drafts",
    description:
      "Every comparison is saved as a draft in this browser, so you can reopen, review and apply it later. Once a live apply is verified, or when there is nothing to remove and Spira already matches the board, the draft moves to Completed.",
    search: "Search drafts by name or module",
  },
  completed: {
    title: "Completed",
    description:
      "Drafts whose test sets match the reviewed board in Spira, either after a verified live apply or because nothing had to be removed. Run the In Scope cases from here.",
    search: "Search completed by name or module",
  },
};

export function DraftList({ bucket = "drafts" }: { bucket?: Bucket }) {
  const router = useRouter();
  const text = BUCKET_TEXT[bucket];
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDrafts(listDrafts());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [checks, setChecks] = useState<Record<string, CheckRecord>>({});
  const [moved, setMoved] = useState<string[]>([]);

  // Drafts with nothing to remove or review are completed once a read-only check finds Spira matches them.
  const checkDrafts = useCallback(async (targets: DraftSummary[]) => {
    if (!targets.length) return;
    setChecking((s) => new Set([...s, ...targets.map((t) => t.id)]));
    const queue = [...targets];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const id = d.id;
        try {
          const result = await completeWithoutChanges(id);
          saveCheck(id, { updatedAt: result.draft.updatedAt, message: result.completed ? null : result.reason });
          if (result.completed) setMoved((m) => [...m, result.draft.name]);
        } catch (err) {
          saveCheck(id, { updatedAt: d.updatedAt, message: `Could not check Spira: ${errorMessage(err)}` });
        } finally {
          setChecking((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
        }
      }
    };
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
    setChecks(readChecks());
    setDrafts(listDrafts());
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(listDrafts)
      .then(
        (loaded) => {
          if (!active) return;
          setDrafts(loaded);
          const done = readChecks();
          setChecks(done);
          void checkDrafts(loaded.filter((d) => d.readyToComplete && done[d.id]?.updatedAt !== d.updatedAt));
        },
        (err) => active && setError(errorMessage(err)),
      );
    return () => {
      active = false;
    };
  }, [checkDrafts]);

  const inBucket = useMemo(
    () =>
      drafts
        ?.filter((d) => !isUatDraftId(d.id) && isCompleted(d.status) === (bucket === "completed"))
        .sort((a, b) => (bucket === "completed" ? (b.completedAt ?? "").localeCompare(a.completedAt ?? "") : 0)) ?? null,
    [drafts, bucket],
  );
  const otherCount =
    drafts && inBucket ? drafts.filter((d) => !isUatDraftId(d.id)).length - inBucket.length : 0;
  /** The newest draft copying each draft to the other platform. */
  const copies = useMemo(
    () => new Map((drafts ?? []).filter((d) => d.mirror).reverse().map((d) => [d.mirror!.sourceDraftId, d])),
    [drafts],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!inBucket) return [];
    return q ? inBucket.filter((d) => `${d.name} ${d.module}`.toLowerCase().includes(q)) : inBucket;
  }, [inBucket, query]);

  async function run(id: string, task: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await task();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const duplicate = (d: DraftSummary) =>
    run(d.id, async () => {
      router.push(`/drafts/${duplicateDraft(d.id).id}`);
    });

  const confirmPending = () => {
    if (!pending) return;
    const { kind, draft } = pending;
    setPending(null);
    void run(draft.id, async () => {
      if (kind === "delete") deleteDraft(draft.id);
      else renameDraft(draft.id, name);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={text.title}
        description={text.description}
        actions={<ButtonLink href="/" variant="primary" icon={Plus}>New comparison</ButtonLink>}
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {moved.length > 0 && (
        <Notice
          tone="success"
          title={`Moved to Completed: ${moved.join(", ")}`}
          action={bucket === "drafts" ? <ButtonLink href="/completed" size="sm">Go to Completed</ButtonLink> : undefined}
        >
          Nothing had to be removed or reviewed, and Spira matches the board, so no live apply was needed.
        </Notice>
      )}

      {inBucket === null && !error ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-44 rounded-2xl" />)}
        </div>
      ) : inBucket && inBucket.length === 0 ? (
        bucket === "completed" ? (
          <EmptyState icon={CircleCheckBig} title="Nothing completed yet" action={<ButtonLink href="/drafts" icon={KanbanSquare}>Open drafts</ButtonLink>}>
            A draft moves here once Spira matches its reviewed board: after a verified live apply, or straight away when nothing has to be removed.
          </EmptyState>
        ) : (
          <EmptyState
            icon={FolderOpen}
            title={otherCount ? "No open drafts" : "No drafts yet"}
            action={<ButtonLink href="/" variant="primary" icon={Plus}>Start a comparison</ButtonLink>}
          >
            {otherCount
              ? <>All your drafts are completed. They are under <Link href="/completed" className="font-medium underline underline-offset-2">Completed</Link>.</>
              : "Upload the scope workbook to compare a module with its Spira test sets."}
          </EmptyState>
        )
      ) : (
        <>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              className="input pl-9"
              placeholder={text.search}
              aria-label={text.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false}>
              {visible.map((d, i) => (
                <motion.li
                  key={d.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 8) * 0.03 } }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  className="surface group flex flex-col gap-4 p-5 transition-shadow hover:shadow-lift"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/drafts/${d.id}`} className="block truncate font-semibold tracking-tight hover:text-brand-600 dark:hover:text-brand-300">
                        {d.name}
                      </Link>
                      <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                        {d.module} · {d.testSetIds.length} test set{d.testSetIds.length === 1 ? "" : "s"} ·{" "}
                        {d.completedAt ? `completed ${relativeTime(d.completedAt)}` : `updated ${relativeTime(d.updatedAt)}`}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                  </div>

                  <ScopeBar counts={d.counts} />

                  {bucket === "drafts" && d.readyToComplete && (
                    checking.has(d.id) ? (
                      <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-zinc-400">
                        <Spinner className="size-3.5" /> Nothing to remove or review. Checking Spira…
                      </p>
                    ) : (
                      <div className="flex items-start gap-3 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:bg-amber-500/[0.07] dark:text-amber-100">
                        <p className="min-w-0 flex-1">
                          {checks[d.id]?.message ?? "Nothing to remove or review: it can move to Completed once Spira is confirmed to match."}
                        </p>
                        <Button size="sm" icon={CircleCheckBig} onClick={() => void checkDrafts([d])}>
                          {checks[d.id]?.message ? "Check again" : "Move to Completed"}
                        </Button>
                      </div>
                    )
                  )}

                  {bucket === "completed" && (
                    <div className="flex items-center gap-3 rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-white/[0.03]">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-slate-500 dark:text-zinc-400">Execution</p>
                        <p className="text-sm font-semibold tabular-nums">
                          {d.execution ? `${d.execution.executed} / ${d.execution.total} executed` : `${d.counts.inScope + d.counts.defects} In Scope to run`}
                        </p>
                      </div>
                      <ButtonLink href={`/drafts/${d.id}/execute`} size="sm" variant="primary" icon={Play}>
                        {d.execution?.executed ? "Continue" : "Run execution"}
                      </ButtonLink>
                    </div>
                  )}

                  {bucket === "completed" && !d.mirror && <PushRow draft={d} copy={copies.get(d.id) ?? null} />}

                  <div className="mt-auto flex items-center gap-1.5">
                    {d.mirror && <Badge tone="brand">From {d.mirror.fromPlatform}</Badge>}
                    {!d.complete && <Badge tone="warning">Comparison incomplete</Badge>}
                    {d.completedWithoutChanges && <Badge tone="neutral">No changes needed</Badge>}
                    <div className="ml-auto flex gap-1 opacity-100 transition-opacity sm:opacity-60 sm:group-hover:opacity-100">
                      <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Rename ${d.name}`} title="Rename" onClick={() => { setName(d.name); setPending({ kind: "rename", draft: d }); }} disabled={busy === d.id} />
                      <Button size="sm" variant="ghost" icon={Copy} aria-label={`Duplicate ${d.name}`} title="Duplicate" onClick={() => duplicate(d)} busy={busy === d.id} />
                      <Button size="sm" variant="ghostDanger" icon={Trash2} aria-label={`Delete ${d.name}`} title="Delete" onClick={() => setPending({ kind: "delete", draft: d })} disabled={busy === d.id} />
                    </div>
                    <ButtonLink href={`/drafts/${d.id}`} size="sm" variant="secondary" icon={ArrowRight}>Open</ButtonLink>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {visible.length === 0 && <p className="text-sm text-slate-500">Nothing matches “{query}”.</p>}
          {bucket === "drafts" && otherCount > 0 && (
            <p className="text-sm text-slate-500 dark:text-zinc-400">
              {otherCount} completed draft{otherCount === 1 ? " is" : "s are"} under{" "}
              <Link href="/completed" className="font-medium text-slate-700 underline underline-offset-2 dark:text-zinc-200">Completed</Link>.
            </p>
          )}
        </>
      )}

      <Dialog
        open={pending?.kind === "delete"}
        onClose={() => setPending(null)}
        title="Delete this draft?"
        footer={
          <>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmPending}>Delete draft</Button>
          </>
        }
      >
        “{pending?.draft.name}” and its board decisions will be removed. Spira is not affected.
      </Dialog>

      <Dialog
        open={pending?.kind === "rename"}
        onClose={() => setPending(null)}
        title="Rename draft"
        footer={
          <>
            <Button onClick={() => setPending(null)}>Cancel</Button>
            <Button variant="primary" onClick={confirmPending} disabled={!name.trim()}>Save</Button>
          </>
        }
      >
        <Field label="Name">
          {(props) => (
            <input {...props} className="input" value={name} maxLength={160} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && confirmPending()} />
          )}
        </Field>
      </Dialog>
    </div>
  );
}
