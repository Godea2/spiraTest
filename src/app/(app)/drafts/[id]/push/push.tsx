"use client";

import { ArrowRightLeft, CheckCircle2, ChevronLeft, ClipboardCheck, ListPlus, Play, RefreshCw, Smartphone, Square, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, ButtonLink, Collapsible, Dialog, Notice, PageHeader, ProgressBar, Section, Spinner, Stat } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  addMissingCases,
  copyResults,
  currentPlan,
  findCounterparts,
  findMirror,
  matchSourceBoard,
  mirrorDirection,
  planCopy,
  startMirror,
  type AddReport,
  type CounterpartOptions,
  type CopyReport,
} from "@/lib/client/mirror";
import { getDraft } from "@/lib/client/drafts";
import { useDraft } from "@/lib/client/use-draft";
import { compareTestSet } from "@/lib/client/workflow";
import { isCompleted, pendingRemovals } from "@/lib/domain/board";
import { STATUS_LABEL } from "@/lib/domain/execution";
import { mirrorMatches, type ResultPlan } from "@/lib/domain/mirror";
import { COLUMN_LABELS, EXECUTION_STATUSES, type Draft, type ExecutionStatus, type Platform } from "@/lib/domain/types";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const STATUS_TONE: Record<ExecutionStatus, "success" | "danger" | "warning"> = {
  passed: "success",
  failed: "danger",
  blocked: "warning",
  caution: "warning",
};

export function Push({ id }: { id: string }) {
  const { draft: source, error: loadError } = useDraft(id);
  const [mirror, setMirror] = useState<Draft | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && setMirror(findMirror(id)));
    return () => {
      active = false;
    };
  }, [id]);

  if (loadError && !source) {
    return <Notice tone="danger" title="This draft could not be opened" action={<ButtonLink href="/completed" size="sm">Back to Completed</ButtonLink>}>{loadError}</Notice>;
  }
  if (!source || mirror === undefined) return <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading…</div>;

  const direction = mirrorDirection(source);
  const header = (
    <PageHeader
      eyebrow={
        <span className="flex flex-wrap items-center gap-2">
          <Link href="/completed" className="inline-flex items-center gap-1 transition hover:text-slate-900 dark:hover:text-white">
            <ChevronLeft className="size-4" aria-hidden /> Completed
          </Link>
          <span className="text-slate-300 dark:text-zinc-700">/</span>
          {source.module}
        </span>
      }
      title={direction ? `Push to ${direction.to}: ${source.name}` : `Push: ${source.name}`}
      description={
        direction
          ? `Makes the ${direction.to} test sets hold exactly the cases the ${direction.from} board kept, then records the ${direction.from} results on them in Spira. Every write is confirmed first; removals go through the usual review and live apply.`
          : undefined
      }
      actions={<ButtonLink href={`/drafts/${source.id}/execute`} variant="ghost">{direction?.from ?? "Source"} execution</ButtonLink>}
    />
  );

  if (!isCompleted(source.status) || !direction || source.mirror) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Notice tone="warning" title="This draft cannot be pushed">
          {!isCompleted(source.status)
            ? "Complete it first (review and live apply), so its board matches Spira."
            : source.mirror
              ? `It already copies ${source.mirror.sourceName}.`
              : "Only a draft whose test sets are all iOS, or all Android, can be pushed to the other platform."}
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      {mirror ? (
        <MirrorSteps source={source} mirror={mirror} setMirror={setMirror} direction={direction} />
      ) : (
        <ChooseTargets source={source} direction={direction} onStarted={setMirror} />
      )}
    </div>
  );
}

function ChooseTargets({ source, direction, onStarted }: { source: Draft; direction: { from: Platform; to: Platform }; onStarted: (d: Draft) => void }) {
  const [options, setOptions] = useState<CounterpartOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    findCounterparts(source, direction.to).then(
      (found) => {
        if (!active) return;
        setOptions(found);
        setPicked(Object.fromEntries(source.testSets.map((s) => [s.testSetId, found.suggested[s.testSetId]?.[0]?.testSetId ?? null])));
      },
      (err) => active && setLoadError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
  }, [source, direction.to]);

  const chosen = Object.values(picked);
  const duplicate = chosen.some((v, i) => v !== null && chosen.indexOf(v) !== i);
  const ready = options !== null && source.testSets.every((s) => picked[s.testSetId]) && !duplicate;

  async function start() {
    if (!options || !ready) return;
    setBusy(true);
    try {
      const byId = new Map(options.all.map((t) => [t.testSetId, t]));
      const targets = source.testSets.map((s) => ({ sourceTestSetId: s.testSetId, target: byId.get(picked[s.testSetId]!)! }));
      onStarted(await startMirror(source, targets, direction));
      toast.success(`Compared the ${direction.to} test sets and matched them to the ${direction.from} board`);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
      const started = findMirror(source.id);
      if (started) onStarted(started);
    }
  }

  return (
    <Section
      icon={Smartphone}
      title={`1. Choose the ${direction.to} test sets`}
      description={`Each ${direction.from} test set is paired with its ${direction.to} counterpart: same module, the other platform's suffix, the same release first. Comparing only reads Spira.`}
    >
      {loadError ? (
        <Notice tone="danger" title="The test sets could not be read from Spira">{loadError}</Notice>
      ) : !options ? (
        <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Reading the test sets in Spira…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {source.testSets.map((s) => {
            const suggested = options.suggested[s.testSetId] ?? [];
            const others = options.all.filter((t) => !suggested.some((x) => x.testSetId === t.testSetId));
            return (
              <label key={s.testSetId} className="grid gap-2 text-sm sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                <span className="font-medium">
                  {s.testSetName} <span className="font-normal text-slate-500">TX:{s.testSetId} · {s.cards.length} cases</span>
                </span>
                <ArrowRightLeft className="hidden size-4 text-slate-400 sm:block" aria-hidden />
                <select
                  className="input"
                  value={picked[s.testSetId] ?? ""}
                  onChange={(e) => setPicked((p) => ({ ...p, [s.testSetId]: e.target.value ? Number(e.target.value) : null }))}
                >
                  <option value="">Choose a test set…</option>
                  {suggested.length > 0 && (
                    <optgroup label={`${direction.to} test sets for ${source.module}`}>
                      {suggested.map((t) => (
                        <option key={t.testSetId} value={t.testSetId}>
                          {t.name} · TX:{t.testSetId}{t.releaseVersion ? ` · Release ${t.releaseVersion}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Other test sets">
                    {others.map((t) => (
                      <option key={t.testSetId} value={t.testSetId}>
                        {t.name} · TX:{t.testSetId}{t.releaseVersion ? ` · Release ${t.releaseVersion}` : ""}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            );
          })}
          {source.testSets.some((s) => (options.suggested[s.testSetId] ?? []).length === 0) && (
            <Notice tone="warning">No {direction.to} test set with a matching name was found for every test set; pick one by hand.</Notice>
          )}
          {duplicate && <Notice tone="warning">Each {direction.from} test set needs its own {direction.to} test set.</Notice>}
          <div>
            <Button variant="primary" icon={ArrowRightLeft} disabled={!ready} busy={busy} onClick={() => void start()}>
              Compare the {direction.to} test sets
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

interface AddJob {
  total: number;
  done: number;
  stopping: boolean;
}

interface CopyJob {
  total: number;
  done: number;
  stopping: boolean;
}

function MirrorSteps({
  source,
  mirror,
  setMirror,
  direction,
}: {
  source: Draft;
  mirror: Draft;
  setMirror: (d: Draft) => void;
  direction: { from: Platform; to: Platform };
}) {
  const plan = useMemo(() => currentPlan(mirror), [mirror]);
  const matches = plan ? mirrorMatches(plan, mirror.decisions) : false;
  const completed = isCompleted(mirror.status);
  const removals = pendingRemovals(mirror);
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [showAdds, setShowAdds] = useState(false);
  const [addJob, setAddJob] = useState<AddJob | null>(null);
  const [addReport, setAddReport] = useState<AddReport | null>(null);
  const [comparing, setComparing] = useState(false);
  const stopRef = useRef(false);

  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<{ plan: ResultPlan; errors: string[] } | null>(null);
  const [tester, setTester] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState(false);
  const [copyJob, setCopyJob] = useState<CopyJob | null>(null);
  const [copyReport, setCopyReport] = useState<CopyReport | null>(null);
  const checkedOnce = useRef(false);

  const canCopy = completed && plan !== null && matches;
  const reload = () => setMirror(getDraft(mirror.id));

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && setTester(getTester()));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!canCopy || checkedOnce.current) return;
    checkedOnce.current = true;
    void checkResults();
    // Reads Spira once when copying becomes possible; later checks are on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCopy]);

  if (!plan) {
    return <Notice tone="danger" title={`The ${direction.to} draft could not be matched to ${source.name}`}>Open it from Drafts to review it on its own.</Notice>;
  }
  const counts = plan.counts;
  const adds = plan.sets.flatMap((s) => s.add.map((a) => ({ ...a, testSetName: mirror.testSets.find((t) => t.testSetId === s.pair.targetTestSetId)?.testSetName ?? "" })));
  const kept = counts.inScope + counts.defects + counts.blocked;

  function match() {
    const out = matchSourceBoard(mirror.id);
    setMirror(out.draft);
    toast.success(out.moved ? `Moved ${plural(out.moved, "card")} to match the ${direction.from} board` : `Already matches the ${direction.from} board`);
  }

  async function compareAgain() {
    setComparing(true);
    try {
      for (const testSetId of mirror.testSetIds) await compareTestSet(mirror.id, testSetId, []);
      setMirror(matchSourceBoard(mirror.id).draft);
      toast.success(`Read the ${direction.to} test sets from Spira again`);
    } catch (err) {
      toast.error(errorMessage(err));
      reload();
    } finally {
      setComparing(false);
    }
  }

  async function addCases() {
    setConfirmAdd(false);
    setAddReport(null);
    stopRef.current = false;
    setAddJob({ total: adds.length, done: 0, stopping: false });
    try {
      const report = await addMissingCases(mirror.id, {
        keepGoing: () => !stopRef.current,
        onBatch: (done) => setAddJob((j) => (j ? { ...j, done } : j)),
      });
      setAddReport(report);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAddJob(null);
      reload();
    }
  }

  async function checkResults() {
    setChecking(true);
    try {
      const out = await planCopy(mirror.id);
      setMirror(out.target);
      setResults({ plan: out.plan, errors: out.errors });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  async function copy(retryKeys?: Set<string>) {
    setConfirmCopy(false);
    setCopyReport(null);
    stopRef.current = false;
    storeTester(tester);
    try {
      let copies = results?.plan.copy ?? [];
      if (retryKeys) {
        const fresh = await planCopy(mirror.id);
        setResults({ plan: fresh.plan, errors: fresh.errors });
        copies = fresh.plan.copy.filter((c) => retryKeys.has(c.card.key));
      }
      if (copies.length === 0) return;
      setCopyJob({ total: copies.length, done: 0, stopping: false });
      const report = await copyResults(mirror.id, copies, tester.trim(), {
        stepByStep: !retryKeys,
        keepGoing: () => !stopRef.current,
        onBatch: (done, d) => {
          setMirror(d);
          setCopyJob((j) => (j ? { ...j, done } : j));
        },
      });
      setCopyReport(report);
      const after = await planCopy(mirror.id);
      setMirror(after.target);
      setResults({ plan: after.plan, errors: after.errors });
    } catch (err) {
      toast.error(errorMessage(err));
      reload();
    } finally {
      setCopyJob(null);
    }
  }

  function stop() {
    stopRef.current = true;
    setAddJob((j) => (j ? { ...j, stopping: true } : j));
    setCopyJob((j) => (j ? { ...j, stopping: true } : j));
  }

  const byStatus = (status: ExecutionStatus) => results?.plan.copy.filter((c) => c.status === status).length ?? 0;
  const withSteps = results?.plan.copy.filter((c) => c.run && c.status !== "passed").length ?? 0;
  const recorded = copyReport?.results.filter((r) => r.result === "recorded").length ?? 0;

  return (
    <>
      <Section
        icon={ListPlus}
        title={`2. Match the ${direction.to} test cases`}
        description={`${mirror.testSets.map((s) => `${s.testSetName} (TX:${s.testSetId})`).join(", ")}: the cases the ${direction.from} board kept stay in the same column, the rest are removed, and kept cases ${direction.to} lacks are added.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/drafts/${mirror.id}`} variant="ghost" size="sm">{direction.to} board</ButtonLink>
            <Button size="sm" icon={RefreshCw} busy={comparing} disabled={!!addJob} onClick={() => void compareAgain()}>Compare again</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label={COLUMN_LABELS.inScope} value={counts.inScope} tone="success" />
            <Stat label={COLUMN_LABELS.defects} value={counts.defects} tone="danger" />
            <Stat label={COLUMN_LABELS.blocked} value={counts.blocked} tone="warning" />
            <Stat label="To remove" value={removals} tone={removals ? "orange" : "neutral"} hint={counts.remove > removals ? `${counts.remove - removals} already removed` : undefined} />
            <Stat label="To add" value={counts.add} tone={counts.add ? "violet" : "neutral"} />
          </dl>

          {Object.keys(mirror.compareErrors).length > 0 && (
            <Notice tone="danger" title="Some test sets could not be compared">
              <ul className="list-disc pl-5">{Object.entries(mirror.compareErrors).map(([setId, message]) => <li key={setId}>TX:{setId}: {message}</li>)}</ul>
              Use Compare again once Spira answers.
            </Notice>
          )}

          {!matches && counts.add === 0 && (
            <Notice tone="warning" title={`The ${direction.from} board changed since the ${direction.to} board was matched`} action={<Button size="sm" variant="primary" onClick={match}>Match again</Button>}>
              Matching only moves cards on the {direction.to} board; nothing changes in Spira.
            </Notice>
          )}

          {addJob && (
            <Notice tone="info" title={`Adding test cases: ${addJob.done} of ${addJob.total}${addJob.stopping ? " (stopping after this batch)" : ""}`} action={<Button size="sm" icon={Square} onClick={stop} disabled={addJob.stopping}>Stop</Button>}>
              <ProgressBar value={addJob.done} max={addJob.total} />
            </Notice>
          )}

          {addReport && !addJob && <AddSummary report={addReport} onDismiss={() => setAddReport(null)} />}

          {counts.add > 0 && (
            <>
              <Collapsible title={`${plural(counts.add, "case")} to add, kept on ${direction.from} but missing on ${direction.to}`} count={counts.add} icon={ListPlus} open={showAdds} onToggle={() => setShowAdds((v) => !v)}>
                <ul className="divide-y divide-slate-100 px-5 pb-3 text-sm dark:divide-white/[0.06]">
                  {adds.map((a, i) => (
                    <li key={`${a.testCaseId}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0">
                        <span className="text-slate-500">TC{a.testCaseId}</span> {a.name}
                      </span>
                      <Badge tone={a.column === "defects" ? "danger" : a.column === "blocked" ? "warning" : "success"}>{COLUMN_LABELS[a.column]}</Badge>
                    </li>
                  ))}
                </ul>
              </Collapsible>
              <div>
                <Button variant="primary" icon={ListPlus} disabled={!!addJob || comparing} onClick={() => setConfirmAdd(true)}>
                  Add {plural(counts.add, "case")} in Spira
                </Button>
              </div>
            </>
          )}

          {counts.add === 0 && matches && !completed && (
            <Notice
              tone="info"
              title={removals ? `Next: remove ${plural(removals, "case")} from the ${direction.to} test set${mirror.testSets.length === 1 ? "" : "s"}` : `Next: confirm the ${direction.to} test sets in Spira`}
              action={<ButtonLink href={`/drafts/${mirror.id}/review`} variant="primary" size="sm">Review &amp; apply</ButtonLink>}
            >
              The usual review runs a membership check, a dry run, and a live apply that asks you to type the module name.
              {counts.blocked ? ` The ${plural(counts.blocked, "Blocked case")} can be signed off there as on ${direction.from}.` : ""}
            </Notice>
          )}
          {counts.add > 0 && !completed && (
            <p className="text-sm text-slate-500 dark:text-zinc-400">Add the missing cases first; then remove the others with Review &amp; apply.</p>
          )}
          {completed && matches && (
            <Notice tone="success" title={`The ${direction.to} test set${mirror.testSets.length === 1 ? "" : "s"} now hold the same ${plural(kept, "case")} as ${direction.from}`}>
              Verified against Spira {mirror.apply.verification?.at ? `on ${new Date(mirror.apply.verification.at).toLocaleString()}` : "after the live apply"}.
            </Notice>
          )}
          {completed && !matches && counts.add > 0 && (
            <Notice tone="warning" title={`The ${direction.from} board now keeps cases ${direction.to} lacks`}>
              Add them here, then review and apply the {direction.to} draft again.
            </Notice>
          )}
        </div>
      </Section>

      <Section
        icon={ClipboardCheck}
        title={`3. Copy the ${direction.from} results to ${direction.to}`}
        description={`Each executed ${direction.to} case gets the latest result its ${direction.from} case shows in Spira, as a new test run: failed, blocked and caution cases step by step with the same actual results, and a comment naming the ${direction.from} run and its defects. Cases that already have a result on ${direction.to} are left alone.`}
        actions={canCopy ? <Button size="sm" icon={RefreshCw} busy={checking} disabled={!!copyJob} onClick={() => void checkResults()}>Check Spira again</Button> : undefined}
      >
        {!canCopy ? (
          <p className="text-sm text-slate-500 dark:text-zinc-400">Available once the {direction.to} test sets match {direction.from} and the {direction.to} draft is completed.</p>
        ) : !results ? (
          <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Reading both platforms&apos; results from Spira…</div>
        ) : (
          <div className="flex flex-col gap-5">
            {results.errors.length > 0 && (
              <Notice tone="warning" title="Spira could not be read in full">
                <ul className="list-disc pl-5">{results.errors.map((e) => <li key={e}>{e}</li>)}</ul>
              </Notice>
            )}
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {EXECUTION_STATUSES.map((s) => (
                <Stat key={s} label={`To record ${STATUS_LABEL[s]}`} value={byStatus(s)} tone={byStatus(s) ? STATUS_TONE[s] : "neutral"} />
              ))}
            </dl>
            <ul className="flex flex-col gap-1 text-sm text-slate-600 dark:text-zinc-400">
              {results.plan.alreadyDone.length > 0 && <li>{plural(results.plan.alreadyDone.length, "case")} already {results.plan.alreadyDone.length === 1 ? "has" : "have"} a result on {direction.to}, left as {results.plan.alreadyDone.length === 1 ? "it is" : "they are"}.</li>}
              {results.plan.notRunOnSource.length > 0 && <li>{plural(results.plan.notRunOnSource.length, "case")} not run on {direction.from} yet, so nothing to copy.</li>}
              {results.plan.notOnSource.length > 0 && <li>{plural(results.plan.notOnSource.length, "case")} not executed on the {direction.from} board.</li>}
              {withSteps > 0 && <li>{plural(withSteps, "non-passed case")} will be copied step by step from the run recorded here.</li>}
            </ul>

            {copyJob && (
              <Notice tone="info" title={`Recording results on ${direction.to}: ${copyJob.done} of ${copyJob.total}${copyJob.stopping ? " (stopping after this batch)" : ""}`} action={<Button size="sm" icon={Square} onClick={stop} disabled={copyJob.stopping}>Stop</Button>}>
                <ProgressBar value={copyJob.done} max={copyJob.total} />
              </Notice>
            )}

            {copyReport && !copyJob && (
              <Notice
                tone={copyReport.failed.length ? "warning" : "success"}
                title={`${plural(recorded, "result")} recorded on ${direction.to}${copyReport.stopped ? " (stopped)" : ""}`}
                action={<Button size="sm" variant="ghost" onClick={() => setCopyReport(null)}>Dismiss</Button>}
              >
                {copyReport.failed.length > 0 && (
                  <>
                    <p>{plural(copyReport.failed.length, "case")} not recorded:</p>
                    <ul className="mt-1 list-disc pl-5 text-xs">
                      {copyReport.failed.slice(0, 8).map((f) => <li key={f.key}>TC{f.testCaseId}: {f.message}</li>)}
                      {copyReport.failed.length > 8 && <li>and {copyReport.failed.length - 8} more</li>}
                    </ul>
                    <Button size="sm" className="mt-2" icon={RefreshCw} onClick={() => void copy(new Set(copyReport.failed.map((f) => f.key)))}>
                      Retry {plural(copyReport.failed.length, "case")} with the result only
                    </Button>
                  </>
                )}
              </Notice>
            )}

            {results.plan.copy.length > 0 ? (
              <div className="flex flex-col gap-4">
                <label className="flex max-w-sm flex-col gap-1 text-sm">
                  <span className="flex items-center gap-1.5 font-medium"><UserRound className="size-4 text-slate-400" aria-hidden /> {direction.to} tester</span>
                  <input
                    className="input"
                    value={tester}
                    maxLength={100}
                    onChange={(e) => setTester(e.target.value)}
                    placeholder="Name written on every run"
                  />
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                  <span>
                    These {plural(results.plan.copy.length, "case")} were run on {direction.to} and gave the same results as on {direction.from}.
                  </span>
                </label>
                <div>
                  <Button variant="primary" icon={Play} disabled={!confirmed || !tester.trim() || !!copyJob || checking} onClick={() => setConfirmCopy(true)}>
                    Record {plural(results.plan.copy.length, "result")} on {direction.to}
                  </Button>
                </div>
              </div>
            ) : (
              <Notice tone="success" title={`Nothing left to copy to ${direction.to}`} action={<ButtonLink href={`/drafts/${mirror.id}/execute`} size="sm" icon={CheckCircle2}>Open {direction.to} execution</ButtonLink>}>
                Every executed {direction.to} case has a result, or its {direction.from} case has not been run yet.
              </Notice>
            )}
          </div>
        )}
      </Section>

      <Dialog
        open={confirmAdd}
        onClose={() => setConfirmAdd(false)}
        title={`Add ${plural(counts.add, "test case")} to ${direction.to}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmAdd(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void addCases()}>Add in Spira</Button>
          </>
        }
      >
        <p>
          Adds each case to {mirror.testSets.map((s) => s.testSetName).join(", ")} in Spira, one at a time. A case already there (on the board, or added in Spira since the last compare) is skipped. The {direction.to} test set
          {mirror.testSets.length === 1 ? " is" : "s are"} then compared again.
        </p>
      </Dialog>

      <Dialog
        open={confirmCopy}
        onClose={() => setConfirmCopy(false)}
        title={`Record ${plural(results?.plan.copy.length ?? 0, "result")} on ${direction.to}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCopy(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void copy()}>Record in Spira</Button>
          </>
        }
      >
        <p>
          Each case gets a new test run in Spira dated now, by {tester.trim() || "the tester"}:{" "}
          {EXECUTION_STATUSES.filter((s) => byStatus(s) > 0).map((s) => `${byStatus(s)} ${STATUS_LABEL[s]}`).join(", ")}. Each run can be undone from the {direction.to} execution page.
        </p>
      </Dialog>
    </>
  );
}

function AddSummary({ report, onDismiss }: { report: AddReport; onDismiss: () => void }) {
  const count = (result: string) => report.results.filter((r) => r.result === result).length;
  const problems = report.results.filter((r) => r.result !== "added");
  return (
    <Notice
      tone={report.errors.length || count("failed") ? "warning" : "success"}
      title={`${plural(count("added"), "case")} added${count("skipped") ? `, ${count("skipped")} skipped` : ""}${count("failed") ? `, ${count("failed")} failed` : ""}`}
      action={<Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
    >
      {(problems.length > 0 || report.errors.length > 0) && (
        <ul className="list-disc pl-5 text-xs">
          {report.errors.map((e) => <li key={e}>{e}</li>)}
          {problems.slice(0, 8).map((r) => <li key={`${r.testSetId}-${r.testCaseId}`}>TC{r.testCaseId} {r.name}: {r.message}</li>)}
          {problems.length > 8 && <li>and {problems.length - 8} more</li>}
        </ul>
      )}
    </Notice>
  );
}
