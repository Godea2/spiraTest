"use client";

import clsx from "clsx";
import { Fragment, useMemo, useState } from "react";
import { Badge, Button, ButtonLink, Notice, PageHeader, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { formatDateTime, STATUS_LABEL, STATUS_TONE } from "@/lib/client/format";
import { useDraft } from "@/lib/client/use-draft";
import { applyBatch, runPreflight, verifyApply } from "@/lib/client/workflow";
import {
  allCards,
  chunk,
  countColumns,
  effectiveColumn,
  isComparisonComplete,
  MAX_APPLY_BATCH,
  removalActions,
} from "@/lib/domain/board";
import type {
  ApplyAction,
  ApplyActionResult,
  Draft,
  PreflightResult,
  VerificationResult,
} from "@/lib/domain/types";

type Mode = "dry" | "live";
type Phase = "idle" | "preflight" | "applying" | "verifying" | "done" | "blocked";

interface SetProgress {
  sent: number;
  total: number;
  results: ApplyActionResult[];
}

export function Review({ id }: { id: string }) {
  const { draft, setDraft, error: loadError } = useDraft(id);

  const [mode, setMode] = useState<Mode>("dry");
  const [confirmText, setConfirmText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [runMode, setRunMode] = useState<Mode>("dry");
  const [progress, setProgress] = useState<Record<number, SetProgress>>({});
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const plan = useMemo(() => {
    if (!draft) return [];
    return draft.testSets.map((set) => ({
      set,
      counts: countColumns(set.cards, draft.decisions),
      actions: removalActions(set, draft.decisions),
    }));
  }, [draft]);

  if (loadError && !draft) {
    return <Notice tone="danger" title="This draft could not be opened">{loadError}</Notice>;
  }
  if (!draft) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading…</div>;

  const totals = countColumns(allCards(draft.testSets), draft.decisions);
  const complete = isComparisonComplete(draft);
  const moduleConfirm = draft.module.toUpperCase();
  const removalCount = plan.reduce((n, p) => n + p.actions.length, 0);
  const running = phase === "preflight" || phase === "applying" || phase === "verifying";

  const liveBlockers = [
    !complete && "Every test set must be compared first.",
    totals.needsReview > 0 && `${totals.needsReview} card${totals.needsReview === 1 ? " is" : "s are"} still in Needs Review.`,
    removalCount === 0 && "There is nothing to remove.",
  ].filter(Boolean) as string[];

  const failedNow = Object.entries(progress).flatMap(([setId, p]) =>
    p.results.filter((r) => r.status === "failed").map((r) => ({ testSetId: Number(setId), action: r })),
  );
  const savedFailures = Object.entries(draft.apply.failed).flatMap(([setId, ids]) => {
    const set = draft.testSets.find((s) => s.testSetId === Number(setId));
    return ids.flatMap((mid) => {
      const card = set?.cards.find((c) => c.testSetTestCaseId === mid && effectiveColumn(c, draft.decisions) === "outOfScope");
      return card ? [{ testSetId: Number(setId), action: { testCaseId: card.testCaseId, testSetTestCaseId: mid } }] : [];
    });
  });
  const retryable = phase === "idle" ? savedFailures : runMode === "live" ? failedNow : [];

  async function run(runAs: Mode, work: Map<number, ApplyAction[]>) {
    if (!draft) return;
    setRunMode(runAs);
    setRunError(null);
    setVerification(null);
    setProgress(Object.fromEntries([...work].map(([setId, actions]) => [setId, { sent: 0, total: actions.length, results: [] }])));

    try {
      setPhase("preflight");
      const pre = await runPreflight(draft.id);
      setPreflight(pre.preflight);
      setDraft(pre.draft);
      if (!pre.preflight.ok && runAs === "live") {
        setPhase("blocked");
        return;
      }

      setPhase("applying");
      let latest = pre.draft;
      for (const [testSetId, actions] of work) {
        for (const batch of chunk(actions, MAX_APPLY_BATCH)) {
          const out = await applyBatch(draft.id, {
            testSetId,
            dryRun: runAs === "dry",
            confirmModule: runAs === "live" ? confirmText : undefined,
            actions: batch,
          });
          latest = out.draft;
          setProgress((p) => ({
            ...p,
            [testSetId]: { ...p[testSetId], sent: p[testSetId].sent + batch.length, results: [...p[testSetId].results, ...out.results] },
          }));
        }
      }
      setDraft(latest);

      if (runAs === "live") {
        setPhase("verifying");
        const ver = await verifyApply(draft.id);
        setVerification(ver.verification);
        setDraft(ver.draft);
      }
      setPhase("done");
    } catch (err) {
      setRunError(errorMessage(err));
      setPhase("done");
    }
  }

  const runAll = () => run(mode, new Map(plan.filter((p) => p.actions.length).map((p) => [p.set.testSetId, p.actions])));

  const retryFailed = () => {
    const work = new Map<number, ApplyAction[]>();
    for (const { testSetId, action } of retryable) {
      work.set(testSetId, [...(work.get(testSetId) ?? []), { testCaseId: action.testCaseId, testSetTestCaseId: action.testSetTestCaseId }]);
    }
    void run("live", work);
  };

  const liveReady = liveBlockers.length === 0 && confirmText === moduleConfirm;
  const canRun = !running && (mode === "dry" ? removalCount > 0 && complete : liveReady);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <ButtonLink href={`/drafts/${draft.id}`} size="sm" variant="ghost" className="-ml-2.5">← Board</ButtonLink>
            <Badge tone={STATUS_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>
          </span>
        }
        title={`Review: ${draft.name}`}
        description={`Removes Out of Scope cases from ${draft.module} test sets in project ${draft.projectId}, release ${draft.releaseLabel || draft.releaseId}. Only removals are made. Nothing is added or edited.`}
      />

      {draft.mock && (
        <Notice tone="warning" title="This is a Mock mode draft">Live apply changes simulated data only. Spira is not contacted.</Notice>
      )}

      <Section title="What will change" description="Cards in Out of Scope are removed from their test set. In Scope cards stay.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Test set</th>
                <th className="py-2 pr-4 text-right font-medium">Keep</th>
                <th className="py-2 pr-4 text-right font-medium">Remove</th>
                <th className="py-2 pr-4 text-right font-medium">Needs Review</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {plan.map(({ set, counts, actions }) => (
                <Fragment key={set.testSetId}>
                  <tr>
                    <td className="py-2.5 pr-4">
                      <span className="font-medium">{set.testSetName}</span> <Badge className="ml-1">{set.platform}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{counts.inScope}</td>
                    <td className="py-2.5 pr-4 text-right font-semibold text-red-600 tabular-nums dark:text-red-400">{actions.length}</td>
                    <td className={clsx("py-2.5 pr-4 text-right tabular-nums", counts.needsReview && "font-semibold text-amber-600 dark:text-amber-400")}>{counts.needsReview}</td>
                    <td className="py-2.5 text-right">
                      {actions.length > 0 && (
                        <Button size="sm" variant="ghost" aria-expanded={expanded === set.testSetId} onClick={() => setExpanded(expanded === set.testSetId ? null : set.testSetId)}>
                          {expanded === set.testSetId ? "Hide" : "Show"} removals
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded === set.testSetId && (
                    <tr>
                      <td colSpan={5} className="pb-3">
                        <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
                          {set.cards.filter((c) => effectiveColumn(c, draft.decisions) === "outOfScope").map((c) => (
                            <li key={c.key} className="flex items-center gap-3 px-3 py-2">
                              <span className="w-20 shrink-0 font-mono text-zinc-500">TC{c.testCaseId}</span>
                              <span className="min-w-0 flex-1 truncate">{c.name}</span>
                              {c.executed && <Badge tone="warning">{c.executionStatus}</Badge>}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Apply">
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Apply mode">
          <ModeCard checked={mode === "dry"} onSelect={() => setMode("dry")} title="Dry run" disabled={running}>
            Checks membership and asks n8n what would be removed. Spira is not changed.
          </ModeCard>
          <ModeCard checked={mode === "live"} onSelect={() => setMode("live")} title="Live apply" danger disabled={running}>
            Removes {removalCount} case{removalCount === 1 ? "" : "s"} from Spira in batches of {MAX_APPLY_BATCH}.
          </ModeCard>
        </div>

        {mode === "live" && (
          <div className="mt-5 flex flex-col gap-4">
            {liveBlockers.length > 0 ? (
              <Notice tone="danger" title="Live apply is blocked" action={<ButtonLink href={`/drafts/${draft.id}`} size="sm">Open board</ButtonLink>}>
                <ul className="list-disc pl-5">{liveBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </Notice>
            ) : (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="confirm-module" className="text-sm font-medium">
                  Type <span className="font-mono font-semibold">{moduleConfirm}</span> to confirm
                </label>
                <input
                  id="confirm-module"
                  className="input max-w-xs font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmText}
                  disabled={running}
                  onChange={(e) => setConfirmText(e.target.value)}
                  aria-describedby="confirm-hint"
                />
                <p id="confirm-hint" className="text-xs text-zinc-500">
                  Before removing anything, every test set is reconciled again. Apply stops if Spira changed since this board was compared.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant={mode === "live" ? "danger" : "primary"} onClick={runAll} disabled={!canRun} busy={running}>
            {mode === "dry" ? "Start dry run" : `Remove ${removalCount} case${removalCount === 1 ? "" : "s"} from Spira`}
          </Button>
          {retryable.length > 0 && !running && (
            <Button onClick={retryFailed} disabled={confirmText !== moduleConfirm || liveBlockers.length > 0} title={confirmText !== moduleConfirm ? `Type ${moduleConfirm} above to enable retry` : undefined}>
              Retry {retryable.length} failed
            </Button>
          )}
          {draft.apply.lastLiveRunAt && phase === "idle" && (
            <span className="text-xs text-zinc-500">Last live run {formatDateTime(draft.apply.lastLiveRunAt)}</span>
          )}
        </div>
        {retryable.length > 0 && !running && mode === "dry" && (
          <p className="mt-2 text-xs text-zinc-500">Retrying failed removals is a live action. Switch to Live apply and confirm the module first.</p>
        )}
      </Section>

      {phase !== "idle" && (
        <RunPanel
          draft={draft}
          phase={phase}
          runMode={runMode}
          progress={progress}
          preflight={preflight}
          verification={verification}
          error={runError}
        />
      )}
    </div>
  );
}

function ModeCard({ checked, onSelect, title, children, danger, disabled }: { checked: boolean; onSelect: () => void; title: string; children: React.ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={clsx(
        "flex flex-col items-start rounded-xl border p-4 text-left transition-colors disabled:opacity-60",
        checked
          ? danger
            ? "border-red-500 bg-red-50 ring-1 ring-red-500 dark:bg-red-950/30"
            : "border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-950/30"
          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className={clsx("size-3.5 rounded-full border-2", checked ? (danger ? "border-red-600 bg-red-600" : "border-brand-600 bg-brand-600") : "border-zinc-400")} aria-hidden />
        {title}
      </span>
      <span className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{children}</span>
    </button>
  );
}

function Step({ state, children }: { state: "todo" | "active" | "done" | "error" | "skip"; children: React.ReactNode }) {
  return (
    <li className={clsx("flex items-center gap-2.5 text-sm", state === "todo" || state === "skip" ? "text-zinc-400" : "")}>
      <span className="grid size-5 place-items-center">
        {state === "active" ? <Spinner className="size-4 text-brand-600" /> :
          state === "done" ? <span className="text-emerald-600">✓</span> :
          state === "error" ? <span className="text-red-600">✕</span> :
          <span className="size-2 rounded-full bg-zinc-300 dark:bg-zinc-700" />}
      </span>
      {children}
    </li>
  );
}

function RunPanel({
  draft,
  phase,
  runMode,
  progress,
  preflight,
  verification,
  error,
}: {
  draft: Draft;
  phase: Phase;
  runMode: Mode;
  progress: Record<number, SetProgress>;
  preflight: PreflightResult | null;
  verification: VerificationResult | null;
  error: string | null;
}) {
  const order: Phase[] = ["preflight", "applying", "verifying", "done"];
  const at = order.indexOf(phase);
  const stepState = (step: Phase) => {
    const i = order.indexOf(step);
    if (phase === "blocked") return step === "preflight" ? "error" : "todo";
    if (error && i === at) return "error";
    if (i < at || phase === "done") return "done";
    return i === at ? "active" : "todo";
  };
  const name = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `Test set ${id}`;
  const results = Object.values(progress).flatMap((p) => p.results);
  const failed = Object.entries(progress).flatMap(([setId, p]) => p.results.filter((r) => r.status === "failed").map((r) => ({ setId: Number(setId), r })));
  const okCount = results.filter((r) => r.status !== "failed").length;

  return (
    <Section title={runMode === "dry" ? "Dry run" : "Live apply"}>
      <ol className="flex flex-col gap-2">
        <Step state={stepState("preflight")}>Check Spira membership matches the reviewed board</Step>
        <Step state={stepState("applying")}>{runMode === "dry" ? "Ask n8n what would be removed" : "Remove cases in batches"}</Step>
        {runMode === "live" && <Step state={stepState("verifying")}>Reconcile again and verify the result</Step>}
      </ol>

      {preflight && !preflight.ok && (
        <Notice tone={runMode === "live" ? "danger" : "warning"} className="mt-5" title={runMode === "live" ? "Stopped: Spira changed since this board was compared" : "Spira changed since this board was compared"}>
          <ul className="mt-1 list-disc pl-5">
            {preflight.sets.filter((s) => !s.ok).map((s) => (
              <li key={s.testSetId}>
                {name(s.testSetId)}: {s.error ?? `${s.unexpected.length} new, ${s.missing.length} no longer present`}
              </li>
            ))}
          </ul>
          <p className="mt-2">Recompare the board, review the differences, then try again. Nothing was removed.</p>
        </Notice>
      )}

      {Object.keys(progress).length > 0 && phase !== "blocked" && (
        <div className="mt-5 flex flex-col gap-4">
          {Object.entries(progress).map(([setId, p]) => {
            const setFailed = p.results.filter((r) => r.status === "failed").length;
            return (
              <div key={setId}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span className="font-medium">{name(Number(setId))}</span>
                  <span className="text-zinc-500 tabular-nums">{p.sent} / {p.total}{setFailed ? <span className="text-red-600"> · {setFailed} failed</span> : null}</span>
                </div>
                <ProgressBar value={p.sent} max={p.total} tone={setFailed ? "danger" : p.sent === p.total ? "success" : "brand"} />
              </div>
            );
          })}
        </div>
      )}

      {error && <Notice tone="danger" className="mt-5" title="The run stopped">{error}</Notice>}

      {phase === "done" && !error && (
        <div className="mt-5 flex flex-col gap-4">
          {runMode === "dry" ? (
            <Notice tone={failed.length ? "warning" : "success"} title="Dry run complete. Spira was not changed.">
              {okCount} case{okCount === 1 ? "" : "s"} would be removed{failed.length ? `; ${failed.length} reported a problem` : ""}.
            </Notice>
          ) : verification?.ok ? (
            <Notice tone="success" title="Applied and verified">Spira membership now matches the reviewed board.</Notice>
          ) : (
            <Notice tone="danger" title={failed.length ? `${failed.length} removal${failed.length === 1 ? "" : "s"} failed` : "Verification found differences"}>
              {failed.length > 0 ? "Use “Retry failed” above. Only the failed removals are sent again." : "Recompare the board to see the current state."}
              {verification && verification.sets.some((s) => !s.ok) && (
                <ul className="mt-1 list-disc pl-5">
                  {verification.sets.filter((s) => !s.ok).map((s) => (
                    <li key={s.testSetId}>{name(s.testSetId)}: {s.error ?? `${s.stillPresent.length} still present, ${s.unexpectedlyRemoved.length} unexpectedly missing`}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          {failed.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500"><tr><th className="py-2 pr-4 font-medium">Test set</th><th className="py-2 pr-4 font-medium">Case</th><th className="py-2 font-medium">Error</th></tr></thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {failed.map(({ setId, r }) => (
                    <tr key={`${setId}-${r.testSetTestCaseId}`}>
                      <td className="py-2 pr-4">{name(setId)}</td>
                      <td className="py-2 pr-4 font-mono text-xs">TC{r.testCaseId}</td>
                      <td className="py-2 text-red-700 dark:text-red-400">{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
