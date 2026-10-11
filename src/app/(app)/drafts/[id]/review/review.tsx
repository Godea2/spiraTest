"use client";

import clsx from "clsx";
import { ChevronLeft, ClipboardList, FlaskConical, ListChecks, RefreshCw, Rocket, RotateCcw, Zap } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, ButtonLink, Dialog, Notice, PageHeader, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { formatDateTime, STATUS_LABEL, STATUS_TONE } from "@/lib/client/format";
import { useDraft } from "@/lib/client/use-draft";
import { applyBatch, signOffBatch, syncWithSpira, undoSignOff, verifyApply } from "@/lib/client/workflow";
import {
  allCards,
  chunk,
  countColumns,
  effectiveColumn,
  isComparisonComplete,
  isCompleted,
  MAX_APPLY_BATCH,
  removalActions,
} from "@/lib/domain/board";
import { keywordHits } from "@/lib/domain/keywords";
import type {
  ApplyAction,
  ApplyActionResult,
  Card,
  Draft,
  PreflightResult,
  SignOffAction,
  SignOffResult,
  SignOffStatus,
  TestSetComparison,
  VerificationResult,
} from "@/lib/domain/types";

type Mode = "dry" | "live";
type Phase = "idle" | "preflight" | "applying" | "verifying" | "signing" | "done" | "blocked";

interface SetProgress {
  sent: number;
  total: number;
  results: ApplyActionResult[];
}

interface SignProgress {
  testSetId: number;
  status: SignOffStatus;
  sent: number;
  total: number;
  results: SignOffResult[];
}

/** Work for one run: removals per test set, then results to record. */
interface Work {
  removals: Map<number, ApplyAction[]>;
  signOff: SignOffAction[];
}

/** The last read-only membership check against Spira. */
interface SpiraCheck {
  checking: boolean;
  preflight: PreflightResult | null;
  adopted: number;
  error: string | null;
}

const STATUS_WORD: Record<SignOffStatus, string> = { blocked: "Blocked", passed: "Passed" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const removedIn = (draft: Draft, testSetId: number) => new Set(draft.apply.removed[String(testSetId)] ?? []);

/** Cards of a column that this app has not already recorded a result for. */
function signOffActions(set: TestSetComparison, draft: Draft, status: SignOffStatus): SignOffAction[] {
  const column = status === "blocked" ? "blocked" : "inScope";
  const done = new Set(
    (draft.apply.signOffRuns ?? []).filter((r) => r.testSetId === set.testSetId && r.status === status).map((r) => r.testSetTestCaseId),
  );
  return set.cards
    .filter((card) => effectiveColumn(card, draft.decisions) === column && !done.has(card.testSetTestCaseId))
    .map((card) => ({ testSetId: set.testSetId, testCaseId: card.testCaseId, testSetTestCaseId: card.testSetTestCaseId, status }));
}

export function Review({ id }: { id: string }) {
  const { draft, setDraft, error: loadError } = useDraft(id);

  const [mode, setMode] = useState<Mode>("dry");
  const [autoPass, setAutoPass] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [confirmPass, setConfirmPass] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [runMode, setRunMode] = useState<Mode>("dry");
  const [progress, setProgress] = useState<Record<number, SetProgress>>({});
  const [signProgress, setSignProgress] = useState<SignProgress[]>([]);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [stoppedAt, setStoppedAt] = useState<Phase | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [undo, setUndo] = useState<{ confirm: boolean; running: boolean; message: string | null; error: string | null }>({
    confirm: false,
    running: false,
    message: null,
    error: null,
  });

  const [spira, setSpira] = useState<SpiraCheck>({ checking: false, preflight: null, adopted: 0, error: null });
  const checkedOnOpen = useRef(false);

  const plan = useMemo(() => {
    if (!draft) return [];
    return draft.testSets.map((set) => {
      const removed = removedIn(draft, set.testSetId);
      const all = removalActions(set, draft.decisions);
      const actions = all.filter((a) => !removed.has(a.testSetTestCaseId));
      return {
        set,
        counts: countColumns(set.cards, draft.decisions),
        actions,
        alreadyRemoved: all.length - actions.length,
        blocked: signOffActions(set, draft, "blocked"),
        passed: signOffActions(set, draft, "passed"),
      };
    });
  }, [draft]);

  const comparedAll = draft ? isComparisonComplete(draft) : false;
  useEffect(() => {
    if (!comparedAll || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    void checkSpira();
    // Runs once when the draft is first available; later checks are on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparedAll]);

  async function checkSpira() {
    setSpira((s) => ({ ...s, checking: true, error: null }));
    try {
      const out = await syncWithSpira(id);
      setDraft(out.draft);
      setSpira({ checking: false, preflight: out.preflight, adopted: out.adopted, error: null });
    } catch (err) {
      setSpira((s) => ({ ...s, checking: false, error: errorMessage(err) }));
    }
  }

  const hits = useMemo(
    () => (draft ? keywordHits(allCards(draft.testSets), draft.testSetKeywords) : new Map<string, string[]>()),
    [draft],
  );

  if (loadError && !draft) {
    return <Notice tone="danger" title="This draft could not be opened">{loadError}</Notice>;
  }
  if (!draft) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading…</div>;

  const totals = countColumns(allCards(draft.testSets), draft.decisions);
  const complete = isComparisonComplete(draft);
  const moduleConfirm = draft.module.toUpperCase();
  const removalCount = plan.reduce((n, p) => n + p.actions.length, 0);
  const blockedCount = plan.reduce((n, p) => n + p.blocked.length, 0);
  const passCount = plan.reduce((n, p) => n + p.passed.length, 0);
  const planned = { remove: removalCount, blocked: blockedCount, passed: autoPass ? passCount : 0 };
  const workCount = planned.remove + planned.blocked + planned.passed;
  const running = phase === "preflight" || phase === "applying" || phase === "verifying" || phase === "signing";
  const recordedRuns = draft.apply.signOffRuns ?? [];
  const releaseText = draft.releaseLabel || draft.releaseId;

  const liveBlockers = [
    !complete && "Every test set must be compared first.",
    totals.needsReview > 0 && `${plural(totals.needsReview, "card")} ${totals.needsReview === 1 ? "is" : "are"} still in Needs Review.`,
    workCount === 0 && "There is nothing to apply.",
    spira.preflight && !spira.preflight.ok && "Spira does not match this board. Recompare the board first.",
  ].filter(Boolean) as string[];
  const nothingLeft = liveBlockers.length === 1 && workCount === 0;
  const alreadyRemoved = plan.reduce((n, p) => n + p.alreadyRemoved, 0);
  const setName = (testSetId: number) => draft.testSets.find((s) => s.testSetId === testSetId)?.testSetName ?? `Test set ${testSetId}`;

  const cardFor = (testSetId: number, membershipId: number): Card | undefined =>
    draft.testSets.find((s) => s.testSetId === testSetId)?.cards.find((c) => c.testSetTestCaseId === membershipId);

  const failedNow = Object.entries(progress).flatMap(([setId, p]) =>
    p.results.filter((r) => r.status === "failed").map((r) => ({ testSetId: Number(setId), action: r })),
  );
  const savedFailures = Object.entries(draft.apply.failed).flatMap(([setId, ids]) =>
    ids.flatMap((mid) => {
      const card = cardFor(Number(setId), mid);
      return card && effectiveColumn(card, draft.decisions) === "outOfScope"
        ? [{ testSetId: Number(setId), action: { testCaseId: card.testCaseId, testSetTestCaseId: mid } }]
        : [];
    }),
  );
  const retryable = phase === "idle" ? savedFailures : runMode === "live" ? failedNow : [];
  const signFailures = (draft.apply.signOffFailed ?? []).filter((a) => {
    const card = cardFor(a.testSetId, a.testSetTestCaseId);
    return card && effectiveColumn(card, draft.decisions) === (a.status === "blocked" ? "blocked" : "inScope");
  });
  const retrySignOff = phase === "idle" || runMode === "live" ? signFailures : [];
  const retryCount = retryable.length + retrySignOff.length;

  async function run(runAs: Mode, work: Work) {
    if (!draft) return;
    setRunMode(runAs);
    setRunError(null);
    setStoppedAt(null);
    setVerification(null);
    let current: Phase = "preflight";
    const enter = (next: Phase) => {
      current = next;
      setPhase(next);
    };
    const progressFor = (removals: Work["removals"]) =>
      Object.fromEntries([...removals].map(([setId, actions]) => [setId, { sent: 0, total: actions.length, results: [] }]));
    setProgress(progressFor(work.removals));
    const groups = new Map<string, SignOffAction[]>();
    for (const a of work.signOff) groups.set(`${a.status}:${a.testSetId}`, [...(groups.get(`${a.status}:${a.testSetId}`) ?? []), a]);
    const ordered = [...groups.values()].sort((a, b) => (a[0].status === b[0].status ? 0 : a[0].status === "blocked" ? -1 : 1));
    setSignProgress(ordered.map((g) => ({ testSetId: g[0].testSetId, status: g[0].status, sent: 0, total: g.length, results: [] })));

    try {
      enter("preflight");
      const pre = await syncWithSpira(draft.id);
      setPreflight(pre.preflight);
      setDraft(pre.draft);
      setSpira({ checking: false, preflight: pre.preflight, adopted: pre.adopted, error: null });
      if (!pre.preflight.ok && runAs === "live") {
        setPhase("blocked");
        return;
      }

      let latest = pre.draft;
      const removals = new Map(
        [...work.removals]
          .map(([testSetId, actions]) => {
            const removed = removedIn(latest, testSetId);
            return [testSetId, actions.filter((a) => !removed.has(a.testSetTestCaseId))] as const;
          })
          .filter(([, actions]) => actions.length > 0),
      );
      setProgress(progressFor(removals));
      if (removals.size > 0) {
        enter("applying");
        for (const [testSetId, actions] of removals) {
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
          enter("verifying");
          const ver = await verifyApply(draft.id);
          setVerification(ver.verification);
          latest = ver.draft;
          setDraft(latest);
        }
      }

      if (ordered.length > 0) {
        enter("signing");
        for (const [index, group] of ordered.entries()) {
          const { testSetId, status } = group[0];
          for (const batch of chunk(group, MAX_APPLY_BATCH)) {
            const notes = Object.fromEntries(
              batch.flatMap((a) => {
                const key = `${a.testSetId}:${a.testSetTestCaseId}`;
                const found = hits.get(key);
                const reason = found ? draft.blockedReview?.[key]?.reason : undefined;
                const note = found ? `${found.join(", ")}${reason ? `. ${reason}` : ""}` : "";
                return status === "blocked" && note ? [[String(a.testSetTestCaseId), note.slice(0, 300)]] : [];
              }),
            );
            const out = await signOffBatch(
              draft.id,
              {
                testSetId,
                status,
                dryRun: runAs === "dry",
                confirmModule: runAs === "live" ? confirmText : undefined,
                actions: batch.map(({ testCaseId, testSetTestCaseId }) => ({ testCaseId, testSetTestCaseId })),
              },
              notes,
            );
            latest = out.draft;
            setSignProgress((all) =>
              all.map((p, i) => (i === index ? { ...p, sent: p.sent + batch.length, results: [...p.results, ...out.results] } : p)),
            );
          }
        }
        setDraft(latest);
      }
      setPhase("done");
    } catch (err) {
      setRunError(errorMessage(err));
      setStoppedAt(current);
      setPhase("done");
    }
  }

  const runAll = () => {
    setConfirmPass(false);
    void run(mode, {
      removals: new Map(plan.filter((p) => p.actions.length).map((p) => [p.set.testSetId, p.actions])),
      signOff: [...plan.flatMap((p) => p.blocked), ...(autoPass ? plan.flatMap((p) => p.passed) : [])],
    });
  };

  const start = () => (mode === "live" && planned.passed > 0 ? setConfirmPass(true) : runAll());

  const retryFailed = () => {
    const removals = new Map<number, ApplyAction[]>();
    for (const { testSetId, action } of retryable) {
      removals.set(testSetId, [...(removals.get(testSetId) ?? []), { testCaseId: action.testCaseId, testSetTestCaseId: action.testSetTestCaseId }]);
    }
    void run("live", { removals, signOff: retrySignOff });
  };

  async function runUndo() {
    if (!draft) return;
    setUndo({ confirm: false, running: true, message: null, error: null });
    try {
      const out = await undoSignOff(draft.id, recordedRuns);
      setDraft(out.draft);
      const deleted = recordedRuns.length - (out.draft.apply.signOffRuns?.length ?? 0);
      setUndo({
        confirm: false,
        running: false,
        message: `Deleted ${plural(deleted, "test run")} from Spira.`,
        error: out.failed.length ? `${plural(out.failed.length, "run")} could not be deleted: ${out.failed[0].message ?? "unknown error"}` : null,
      });
    } catch (err) {
      setUndo({ confirm: false, running: false, message: null, error: errorMessage(err) });
    }
  }

  const liveReady = liveBlockers.length === 0 && confirmText === moduleConfirm;
  const canRun = !running && !undo.running && (mode === "dry" ? workCount > 0 && complete : liveReady);
  const liveParts = [
    planned.remove && `remove ${planned.remove}`,
    planned.blocked && `mark ${planned.blocked} Blocked`,
    planned.passed && `mark ${planned.passed} Passed`,
  ].filter(Boolean) as string[];
  const liveLabel = liveParts.length ? `Apply: ${liveParts.join(", ")}` : "Apply to Spira";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <ButtonLink href={`/drafts/${draft.id}`} size="sm" variant="ghost" icon={ChevronLeft} className="-ml-2.5">Board</ButtonLink>
            <Badge tone={STATUS_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>
          </span>
        }
        title={`Review: ${draft.name}`}
        description={`Final approval for ${draft.module} in project ${draft.projectId}${releaseText ? `, release ${releaseText}` : ""}. Out of Scope cases are removed from their test sets. Blocked cases, and In Scope cases if you choose, get a test result recorded in Spira. Test cases and their steps are never edited or deleted.`}
      />

      <Section icon={ListChecks} title="What will change" description="Out of Scope cards are removed from their test set. Blocked cards stay in the test set and are recorded as Blocked. In Scope cards stay.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Test set</th>
                <th className="py-2 pr-4 text-right font-medium">In Scope</th>
                <th className="py-2 pr-4 text-right font-medium">Defects</th>
                <th className="py-2 pr-4 text-right font-medium">Blocked</th>
                <th className="py-2 pr-4 text-right font-medium">Remove</th>
                <th className="py-2 pr-4 text-right font-medium">Needs Review</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {plan.map(({ set, counts, actions, alreadyRemoved: done }) => (
                <Fragment key={set.testSetId}>
                  <tr>
                    <td className="py-2.5 pr-4">
                      <span className="font-medium">{set.testSetName}</span> <Badge className="ml-1">{set.platform}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{counts.inScope}</td>
                    <td className={clsx("py-2.5 pr-4 text-right tabular-nums", counts.defects > 0 && "font-semibold text-violet-600 dark:text-violet-400")} title="Kept in the test set and run as Failed">{counts.defects}</td>
                    <td className="py-2.5 pr-4 text-right font-semibold text-orange-600 tabular-nums dark:text-orange-400">{counts.blocked}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">
                      <span className="font-semibold text-red-600 dark:text-red-400">{actions.length}</span>
                      {done > 0 && <span className="block text-xs text-zinc-500">{done} already removed</span>}
                    </td>
                    <td className={clsx("py-2.5 pr-4 text-right tabular-nums", counts.needsReview && "font-semibold text-amber-600 dark:text-amber-400")}>{counts.needsReview}</td>
                    <td className="py-2.5 text-right">
                      {(actions.length > 0 || done > 0 || counts.blocked > 0 || counts.defects > 0) && (
                        <Button size="sm" variant="ghost" aria-expanded={expanded === set.testSetId} onClick={() => setExpanded(expanded === set.testSetId ? null : set.testSetId)}>
                          {expanded === set.testSetId ? "Hide" : "Show"} cases
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded === set.testSetId && (
                    <tr>
                      <td colSpan={7} className="pb-3">
                        <CaseList title="Defects (kept)" cards={set.cards.filter((c) => effectiveColumn(c, draft.decisions) === "defects")} hits={hits} />
                        <CaseList title="Blocked" cards={set.cards.filter((c) => effectiveColumn(c, draft.decisions) === "blocked")} hits={hits} review={draft.blockedReview} />
                        <CaseList title="Remove" cards={set.cards.filter((c) => effectiveColumn(c, draft.decisions) === "outOfScope" && !removedIn(draft, set.testSetId).has(c.testSetTestCaseId))} hits={hits} />
                        <CaseList title="Already removed" cards={set.cards.filter((c) => effectiveColumn(c, draft.decisions) === "outOfScope" && removedIn(draft, set.testSetId).has(c.testSetTestCaseId))} hits={hits} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {complete && (
          <div className="mt-4 flex flex-col gap-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {spira.checking ? (
                <span className="flex items-center gap-2 text-zinc-500"><Spinner /> Checking test set membership in Spira…</span>
              ) : spira.preflight ? (
                <span className="text-zinc-600 dark:text-zinc-400">
                  Checked against Spira at {formatDateTime(spira.preflight.at)}.{" "}
                  {spira.adopted > 0 && `${plural(spira.adopted, "Out of Scope case")} ${spira.adopted === 1 ? "was" : "were"} already gone from Spira and now count as removed. `}
                  {alreadyRemoved > 0 && `${alreadyRemoved} removed so far, `}
                  {plural(removalCount, "case")} left to remove.
                </span>
              ) : (
                <span className="text-zinc-500">Spira has not been checked yet.</span>
              )}
              {!spira.checking && (
                <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void checkSpira()} disabled={running}>
                  Check Spira again
                </Button>
              )}
            </div>
            {spira.error && <Notice tone="warning" title="Spira could not be checked">{spira.error}</Notice>}
            {spira.preflight && !spira.preflight.ok && !spira.checking && (
              <Notice
                tone="warning"
                title="Spira does not match this board"
                action={<ButtonLink href={`/drafts/${draft.id}`} size="sm">Open board</ButtonLink>}
              >
                <ul className="mt-1 list-disc pl-5">
                  {spira.preflight.sets.filter((s) => !s.ok).map((s) => (
                    <li key={s.testSetId}>
                      {setName(s.testSetId)}:{" "}
                      {s.error ??
                        [
                          s.unexpected.length > 0 && `${plural(s.unexpected.length, "case")} in Spira ${s.unexpected.length === 1 ? "is" : "are"} not on this board`,
                          s.missing.length > 0 && `${plural(s.missing.length, "case")} on this board ${s.missing.length === 1 ? "is" : "are"} no longer in Spira`,
                        ]
                          .filter(Boolean)
                          .join("; ")}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">Someone changed these test sets outside this review. Recompare the board and review the differences before applying.</p>
              </Notice>
            )}
          </div>
        )}
      </Section>

      <Section icon={Rocket} title="Apply">
        <label className="well mb-5 flex items-start gap-3 p-4">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-brand-600"
            checked={autoPass}
            disabled={running}
            onChange={(e) => setAutoPass(e.target.checked)}
          />
          <span className="text-sm">
            <span className="font-semibold">Also mark In Scope cases as Passed</span>
            <span className="mt-0.5 block text-zinc-600 dark:text-zinc-400">
              Records an automated Passed result for each of the {plural(passCount, "In Scope case")}; any that already have a result in Spira are skipped. Only use this when these cases really were tested and signed off.
            </span>
          </span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Apply mode">
          <ModeCard checked={mode === "dry"} onSelect={() => setMode("dry")} title="Dry run" disabled={running}>
            Checks membership and which results would be recorded. Spira is not changed.
          </ModeCard>
          <ModeCard checked={mode === "live"} onSelect={() => setMode("live")} title="Live apply" danger disabled={running}>
            {liveParts.length ? `Will ${liveParts.join(", ")} in Spira, in batches of ${MAX_APPLY_BATCH}.` : "Nothing to change yet."}
          </ModeCard>
        </div>

        {(planned.blocked > 0 || planned.passed > 0) && (
          <p className="mt-3 text-xs text-zinc-500">
            {releaseText
              ? `Results are recorded against release ${releaseText}.`
              : "No release is set on this draft, so each result is recorded against the release its test set is planned for in Spira."}{" "}
            Cases that already have a result in Spira are skipped and listed. Results recorded here can be undone below.
          </p>
        )}

        {mode === "live" && (
          <div className="mt-5 flex flex-col gap-4">
            {nothingLeft ? (
              <Notice
                tone="success"
                title="Nothing left to apply"
              action={isCompleted(draft.status) ? <ButtonLink href={`/drafts/${draft.id}/execute`} size="sm">Run execution</ButtonLink> : undefined}
            >
              Spira already matches this board.
                {passCount > 0 && " To record Passed results for the In Scope cases, tick the option above."}
              </Notice>
            ) : liveBlockers.length > 0 ? (
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
                  Before anything changes, every test set is reconciled again. Apply stops if Spira changed since this board was compared.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant={mode === "live" ? "danger" : "primary"} icon={mode === "dry" ? FlaskConical : Zap} onClick={start} disabled={!canRun} busy={running}>
            {mode === "dry" ? "Start dry run" : liveLabel}
          </Button>
          {retryCount > 0 && !running && (
            <Button icon={RotateCcw} onClick={retryFailed} disabled={confirmText !== moduleConfirm || liveBlockers.length > 0} title={confirmText !== moduleConfirm ? `Type ${moduleConfirm} above to enable retry` : undefined}>
              Retry {retryCount} failed
            </Button>
          )}
          {draft.apply.lastLiveRunAt && phase === "idle" && (
            <span className="text-xs text-zinc-500">Last live run {formatDateTime(draft.apply.lastLiveRunAt)}</span>
          )}
        </div>
        {retryCount > 0 && !running && mode === "dry" && (
          <p className="mt-2 text-xs text-zinc-500">Retrying failed changes is a live action. Switch to Live apply and confirm the module first.</p>
        )}
      </Section>

      {phase !== "idle" && (
        <RunPanel
          draft={draft}
          phase={phase}
          runMode={runMode}
          progress={progress}
          signProgress={signProgress}
          preflight={preflight}
          verification={verification}
          error={runError}
          stoppedAt={stoppedAt}
        />
      )}

      {(recordedRuns.length > 0 || undo.message || undo.error) && (
        <Section
          icon={ClipboardList}
          title="Recorded results"
          description="Test runs this app recorded in Spira for this draft. Undo deletes only these runs; each one is checked to have been recorded by this app first."
        >
          {recordedRuns.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                {plural(recordedRuns.filter((r) => r.status === "blocked").length, "Blocked result")},{" "}
                {plural(recordedRuns.filter((r) => r.status === "passed").length, "Passed result")}
              </span>
              <Button variant="danger" size="sm" onClick={() => setUndo((u) => ({ ...u, confirm: true }))} disabled={running || undo.running} busy={undo.running}>
                Undo sign-off
              </Button>
            </div>
          )}
          {undo.message && <Notice tone="success" className="mt-4">{undo.message}</Notice>}
          {undo.error && <Notice tone="danger" className="mt-4" title="Undo did not finish">{undo.error}</Notice>}
        </Section>
      )}

      <Dialog
        open={confirmPass}
        onClose={() => setConfirmPass(false)}
        title={`Mark ${plural(planned.passed, "case")} as Passed?`}
        footer={
          <>
            <Button onClick={() => setConfirmPass(false)}>Cancel</Button>
            <Button variant="danger" onClick={runAll}>Record Passed results</Button>
          </>
        }
      >
        <p>
          Every In Scope case without a result gets an automated Passed test run in Spira, and shows as Passed in release and test set reports.
          Only continue if these cases were tested and signed off.
        </p>
      </Dialog>

      <Dialog
        open={undo.confirm}
        onClose={() => setUndo((u) => ({ ...u, confirm: false }))}
        title={`Delete ${plural(recordedRuns.length, "test run")} from Spira?`}
        footer={
          <>
            <Button onClick={() => setUndo((u) => ({ ...u, confirm: false }))}>Cancel</Button>
            <Button variant="danger" onClick={() => void runUndo()}>Delete test runs</Button>
          </>
        }
      >
        <p>
          The Blocked and Passed results this app recorded are deleted, and those cases go back to their previous status in Spira.
          Removed test set memberships are not restored.
        </p>
      </Dialog>
    </div>
  );
}

function CaseList({
  title,
  cards,
  hits,
  review,
}: {
  title: string;
  cards: Card[];
  hits: Map<string, string[]>;
  review?: Draft["blockedReview"];
}) {
  if (cards.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="mb-1 text-xs font-medium text-zinc-500">{title} ({cards.length})</p>
      <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
        {cards.map((c) => (
          <li key={c.key} className="flex items-center gap-3 px-3 py-2">
            <span className="w-20 shrink-0 font-mono text-zinc-500">TC{c.testCaseId}</span>
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            {hits.get(c.key) && (
              <span title={review?.[c.key]?.reason}>
                <Badge>{hits.get(c.key)!.join(", ")}</Badge>
              </span>
            )}
            {c.executed && <Badge tone="warning">{c.executionStatus}</Badge>}
          </li>
        ))}
      </ul>
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
  signProgress,
  preflight,
  verification,
  error,
  stoppedAt,
}: {
  draft: Draft;
  phase: Phase;
  runMode: Mode;
  progress: Record<number, SetProgress>;
  signProgress: SignProgress[];
  preflight: PreflightResult | null;
  verification: VerificationResult | null;
  error: string | null;
  stoppedAt: Phase | null;
}) {
  const hasRemovals = Object.keys(progress).length > 0;
  const hasSignOff = signProgress.length > 0;
  const order: Phase[] = ["preflight", "applying", "verifying", "signing", "done"];
  const at = order.indexOf(stoppedAt ?? phase);
  const stepState = (step: Phase) => {
    const i = order.indexOf(step);
    if (phase === "blocked") return step === "preflight" ? "error" : "todo";
    if (error && stoppedAt) return i < at ? "done" : i === at ? "error" : "todo";
    if (i < at || phase === "done") return "done";
    return i === at ? "active" : "todo";
  };
  const name = (id: number) => draft.testSets.find((s) => s.testSetId === id)?.testSetName ?? `Test set ${id}`;
  const caseName = (setId: number, mid: number) =>
    draft.testSets.find((s) => s.testSetId === setId)?.cards.find((c) => c.testSetTestCaseId === mid)?.name ?? `Membership ${mid}`;

  const results = Object.values(progress).flatMap((p) => p.results);
  const failed = Object.entries(progress).flatMap(([setId, p]) => p.results.filter((r) => r.status === "failed").map((r) => ({ setId: Number(setId), r })));
  const okCount = results.filter((r) => r.status !== "failed").length;

  const signResults = signProgress.flatMap((p) => p.results);
  const signCount = (outcome: SignOffResult["result"], status?: SignOffStatus) =>
    signResults.filter((r) => r.result === outcome && (!status || r.status === status)).length;
  const signIssues = signResults.filter((r) => r.result === "failed" || r.result === "skipped");
  const signFailed = signCount("failed");
  const removalsOk = !hasRemovals || (runMode === "dry" ? true : verification?.ok && failed.length === 0);

  return (
    <Section title={runMode === "dry" ? "Dry run" : "Live apply"}>
      <ol className="flex flex-col gap-2">
        <Step state={stepState("preflight")}>Check Spira membership matches the reviewed board</Step>
        {hasRemovals && <Step state={stepState("applying")}>{runMode === "dry" ? "Confirm what would be removed" : "Remove cases in batches"}</Step>}
        {hasRemovals && runMode === "live" && <Step state={stepState("verifying")}>Reconcile again and verify the result</Step>}
        {hasSignOff && <Step state={stepState("signing")}>{runMode === "dry" ? "Check which results would be recorded" : "Record Blocked and Passed results"}</Step>}
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
          <p className="mt-2">Recompare the board, review the differences, then try again. Nothing was changed.</p>
        </Notice>
      )}

      {phase !== "blocked" && (hasRemovals || hasSignOff) && (
        <div className="mt-5 flex flex-col gap-4">
          {Object.entries(progress).map(([setId, p]) => {
            const setFailed = p.results.filter((r) => r.status === "failed").length;
            return (
              <ProgressRow key={`remove-${setId}`} label={`Remove · ${name(Number(setId))}`} sent={p.sent} total={p.total} failed={setFailed} />
            );
          })}
          {signProgress.map((p) => (
            <ProgressRow
              key={`${p.status}-${p.testSetId}`}
              label={`${STATUS_WORD[p.status]} · ${name(p.testSetId)}`}
              sent={p.sent}
              total={p.total}
              failed={p.results.filter((r) => r.result === "failed").length}
            />
          ))}
        </div>
      )}

      {error && <Notice tone="danger" className="mt-5" title="The run stopped">{error}</Notice>}

      {phase === "done" && !error && (
        <div className="mt-5 flex flex-col gap-4">
          {runMode === "dry" ? (
            <Notice tone={failed.length || signFailed ? "warning" : "success"} title="Dry run complete. Spira was not changed.">
              {[
                hasRemovals && `${plural(okCount, "case")} would be removed${failed.length ? `; ${failed.length} reported a problem` : ""}.`,
                hasSignOff &&
                  `${signCount("wouldRecord", "blocked")} Blocked and ${signCount("wouldRecord", "passed")} Passed result(s) would be recorded; ${signCount("skipped")} skipped${signFailed ? `, ${signFailed} reported a problem` : ""}.`,
              ]
                .filter(Boolean)
                .join(" ")}
            </Notice>
          ) : removalsOk && signFailed === 0 ? (
            <Notice
              tone="success"
              title="Applied"
              action={isCompleted(draft.status) ? <ButtonLink href="/completed" size="sm">Go to Completed</ButtonLink> : undefined}
            >
              {[
                hasRemovals && "Spira membership now matches the reviewed board.",
                hasSignOff &&
                  `Recorded ${signCount("recorded", "blocked")} Blocked and ${signCount("recorded", "passed")} Passed result(s); ${signCount("skipped")} skipped.`,
                isCompleted(draft.status) && "This draft has moved to Completed.",
              ]
                .filter(Boolean)
                .join(" ")}
            </Notice>
          ) : (
            <Notice tone="danger" title={failed.length + signFailed ? `${failed.length + signFailed} change${failed.length + signFailed === 1 ? "" : "s"} failed` : "Verification found differences"}>
              {failed.length + signFailed > 0 ? "Use “Retry failed” above. Only the failed changes are sent again." : "Recompare the board to see the current state."}
              {verification && verification.sets.some((s) => !s.ok) && (
                <ul className="mt-1 list-disc pl-5">
                  {verification.sets.filter((s) => !s.ok).map((s) => (
                    <li key={s.testSetId}>{name(s.testSetId)}: {s.error ?? `${s.stillPresent.length} still present, ${s.unexpectedlyRemoved.length} unexpectedly missing`}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
          {(failed.length > 0 || signIssues.length > 0) && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500"><tr><th className="py-2 pr-4 font-medium">Test set</th><th className="py-2 pr-4 font-medium">Case</th><th className="py-2 pr-4 font-medium">Change</th><th className="py-2 font-medium">Outcome</th></tr></thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {failed.map(({ setId, r }) => (
                    <tr key={`remove-${setId}-${r.testSetTestCaseId}`}>
                      <td className="py-2 pr-4">{name(setId)}</td>
                      <td className="py-2 pr-4"><span className="font-mono text-xs">TC{r.testCaseId}</span> {caseName(setId, r.testSetTestCaseId)}</td>
                      <td className="py-2 pr-4">Remove</td>
                      <td className="py-2 text-red-700 dark:text-red-400">{r.message}</td>
                    </tr>
                  ))}
                  {signIssues.map((r) => (
                    <tr key={`${r.status}-${r.testSetId}-${r.testSetTestCaseId}`}>
                      <td className="py-2 pr-4">{name(r.testSetId)}</td>
                      <td className="py-2 pr-4"><span className="font-mono text-xs">TC{r.testCaseId}</span> {caseName(r.testSetId, r.testSetTestCaseId)}</td>
                      <td className="py-2 pr-4">{STATUS_WORD[r.status]}</td>
                      <td className={clsx("py-2", r.result === "failed" ? "text-red-700 dark:text-red-400" : "text-zinc-500")}>
                        {r.result === "skipped" ? "Skipped: " : ""}{r.message}
                      </td>
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

function ProgressRow({ label, sent, total, failed }: { label: string; sent: number; total: number; failed: number }) {
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-zinc-500 tabular-nums">{sent} / {total}{failed ? <span className="text-red-600"> · {failed} failed</span> : null}</span>
      </div>
      <ProgressBar value={sent} max={total} tone={failed ? "danger" : sent === total ? "success" : "brand"} />
    </div>
  );
}
