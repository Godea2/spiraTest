"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Field, Notice, PageHeader, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { deleteDraft, duplicateDraft, listDrafts, renameDraft } from "@/lib/client/drafts";
import { relativeTime, STATUS_LABEL, STATUS_TONE } from "@/lib/client/format";
import type { DraftSummary } from "@/lib/domain/types";

type Pending = { kind: "rename" | "delete"; draft: DraftSummary } | null;

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
        actions={<ButtonLink href="/" variant="primary">New comparison</ButtonLink>}
      />
      {error && <Notice tone="danger">{error}</Notice>}

      {drafts === null && !error ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading drafts…</div>
      ) : drafts && drafts.length === 0 ? (
        <EmptyState title="No drafts yet" action={<ButtonLink href="/" variant="primary">Start a comparison</ButtonLink>}>
          Upload the scope workbook to compare a module with its Spira test sets.
        </EmptyState>
      ) : (
        <>
          <input
            type="search"
            className="input max-w-sm"
            placeholder="Search drafts"
            aria-label="Search drafts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="surface divide-y divide-zinc-100 dark:divide-zinc-800">
            {visible.map((d) => (
              <li key={d.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-6">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/drafts/${d.id}`} className="truncate font-medium hover:underline">
                      {d.name}
                    </Link>
                    <Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Badge>
                    {!d.complete && <Badge tone="warning">Comparison incomplete</Badge>}                  </div>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {d.module} · {d.testSetIds.length} test set{d.testSetIds.length === 1 ? "" : "s"} · updated {relativeTime(d.updatedAt)}
                  </p>
                </div>
                <dl className="flex gap-5 text-xs tabular-nums">
                  <div><dt className="text-zinc-500">In</dt><dd className="font-semibold">{d.counts.inScope}</dd></div>
                  <div><dt className="text-zinc-500">Out</dt><dd className="font-semibold">{d.counts.outOfScope}</dd></div>
                  <div>
                    <dt className="text-zinc-500">Review</dt>
                    <dd className={d.counts.needsReview ? "font-semibold text-amber-600 dark:text-amber-400" : "font-semibold"}>{d.counts.needsReview}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap gap-1.5">
                  <ButtonLink href={`/drafts/${d.id}`} size="sm" variant="secondary">Open</ButtonLink>
                  <Button size="sm" variant="ghost" onClick={() => { setName(d.name); setPending({ kind: "rename", draft: d }); }} disabled={busy === d.id}>Rename</Button>
                  <Button size="sm" variant="ghost" onClick={() => duplicate(d)} busy={busy === d.id}>Duplicate</Button>
                  <Button size="sm" variant="ghostDanger" onClick={() => setPending({ kind: "delete", draft: d })} disabled={busy === d.id}>Delete</Button>
                </div>
              </li>
            ))}
            {visible.length === 0 && <li className="p-4 text-sm text-zinc-500">No drafts match “{query}”.</li>}
          </ul>
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
