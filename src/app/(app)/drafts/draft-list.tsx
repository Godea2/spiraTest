"use client";

import clsx from "clsx";
import { ArrowRight, Copy, FolderOpen, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { deleteDraft, duplicateDraft, listDrafts, renameDraft } from "@/lib/client/drafts";
import { relativeTime, STATUS_LABEL, STATUS_TONE } from "@/lib/client/format";
import { COLUMN_LABELS, COLUMNS, type DraftSummary } from "@/lib/domain/types";

type Pending = { kind: "rename" | "delete"; draft: DraftSummary } | null;

const SCOPE_COLOR: Record<(typeof COLUMNS)[number], string> = {
  inScope: "bg-emerald-500",
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
      <dl className="mt-3 grid grid-cols-4 gap-2 text-xs">
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

export function DraftList() {
  const router = useRouter();
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

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(listDrafts)
      .then(
        (loaded) => active && setDrafts(loaded),
        (err) => active && setError(errorMessage(err)),
      );
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!drafts) return [];
    return q ? drafts.filter((d) => `${d.name} ${d.module}`.toLowerCase().includes(q)) : drafts;
  }, [drafts, query]);

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
        title="Drafts"
        description="Every comparison is saved as a draft in this browser, so you can reopen, review and apply it later."
        actions={<ButtonLink href="/" variant="primary" icon={Plus}>New comparison</ButtonLink>}
      />
      {error && <Notice tone="danger">{error}</Notice>}

      {drafts === null && !error ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-44 rounded-2xl" />)}
        </div>
      ) : drafts && drafts.length === 0 ? (
        <EmptyState icon={FolderOpen} title="No drafts yet" action={<ButtonLink href="/" variant="primary" icon={Plus}>Start a comparison</ButtonLink>}>
          Upload the scope workbook to compare a module with its Spira test sets.
        </EmptyState>
      ) : (
        <>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="search"
              className="input pl-9"
              placeholder="Search drafts by name or module"
              aria-label="Search drafts"
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
                        {d.module} · {d.testSetIds.length} test set{d.testSetIds.length === 1 ? "" : "s"} · updated {relativeTime(d.updatedAt)}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                  </div>

                  <ScopeBar counts={d.counts} />

                  <div className="mt-auto flex items-center gap-1.5">
                    {!d.complete && <Badge tone="warning">Comparison incomplete</Badge>}
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
          {visible.length === 0 && <p className="text-sm text-slate-500">No drafts match “{query}”.</p>}
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
