"use client";

import clsx from "clsx";
import { Check, CircleCheckBig, FileSpreadsheet, Layers, RefreshCw, Search, Sparkles, Square, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Notice, PageHeader, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { allDrafts } from "@/lib/client/drafts";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  MAX_PROGRESS_TEXT,
  passProgress,
  progressTargets,
  readLeftOutModules,
  searchProgress,
  storeLeftOutModules,
  type PassProgressOutcome,
  type ProgressCase,
  type ProgressPhase,
  type ProgressSearch,
} from "@/lib/client/progress";
import { isCompleted } from "@/lib/domain/board";
import { currentStatus, STATUS_LABEL } from "@/lib/domain/execution";
import type { BlockedConfidence, Draft, ExecutionStatus } from "@/lib/domain/types";
import { StatusChip } from "../drafts/[id]/execute/runner";
import { ImportPanel } from "./import-panel";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const RELEVANCE_TONE: Record<BlockedConfidence, "brand" | "warning" | "neutral"> = { high: "brand", medium: "warning", low: "neutral" };

const EXAMPLE = "For example: Tested airtime purchase and top-up on iOS this week, including saved beneficiaries and the receipt.";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="shrink-0 text-slate-400 tabular-nums">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

function phaseText(phase: ProgressPhase): string {
  if (phase.stage === "understanding") return `Gemini is working out which feature you covered (${plural(phase.modules, "module")} to search)…`;
  return `Matching ${plural(phase.total, "case")} in ${plural(phase.modules, "module")} to ${phase.feature ? `"${phase.feature}"` : "the work"}…`;
}

/** Whether a case should be ticked by default: still to run, and Gemini is at least medium sure. */
function defaultOn(status: ExecutionStatus | null, relevance: BlockedConfidence): boolean {
  return status === null && (relevance === "high" || relevance === "medium");
}

export function ProgressWorkspace() {
  const { settings, ai, spira } = useSettings();
  const aiOn = !!ai?.configured;
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickedProject, setProject] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [tester, setTester] = useState("");
  const [completedOnly, setCompletedOnly] = useState(true);
  const [releaseOnly, setReleaseOnly] = useState(true);
  const [mode, setMode] = useState<"describe" | "upload">("describe");
  const settingsReleaseId = settings?.releaseId ?? null;
  const settingsReleaseLabel = settings?.releaseLabel?.trim() || (settingsReleaseId !== null ? `RL:${settingsReleaseId}` : "");

  const refresh = useCallback(() => {
    try {
      setDrafts(allDrafts());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => allDrafts())
      .then(
        (all) => {
          if (!active) return;
          setDrafts(all);
          setTester(getTester());
          setExcluded(new Set(readLeftOutModules()));
        },
        (err) => active && setLoadError(errorMessage(err)),
      );
    return () => {
      active = false;
    };
  }, []);

  const projects = useMemo(() => [...new Set((drafts ?? []).filter((d) => d.testSets.length > 0).map((d) => d.projectId))], [drafts]);
  const settingsProject = settings?.projectId ?? null;
  const projectId = useMemo(() => {
    if (pickedProject !== null && projects.includes(pickedProject)) return pickedProject;
    if (settingsProject !== null && projects.includes(settingsProject)) return settingsProject;
    return projects[0] ?? null;
  }, [pickedProject, projects, settingsProject]);

  const inProject = useMemo(() => (drafts ?? []).filter((d) => d.projectId === projectId && d.testSets.length > 0), [drafts, projectId]);
  const inRelease = useMemo(() => {
    if (!releaseOnly || settingsReleaseId === null) return inProject;
    const matched = inProject.filter((d) => d.releaseId === settingsReleaseId);
    return matched.length > 0 ? matched : inProject;
  }, [inProject, releaseOnly, settingsReleaseId]);
  const pool = useMemo(() => (completedOnly ? inRelease.filter((d) => isCompleted(d.status)) : inRelease), [inRelease, completedOnly]);
  const releaseMatchCount = useMemo(
    () => (settingsReleaseId === null ? inProject.length : inProject.filter((d) => d.releaseId === settingsReleaseId).length),
    [inProject, settingsReleaseId],
  );
  const scoped = useMemo(() => pool.filter((d) => !excluded.has(d.id)), [pool, excluded]);
  const draftsById = useMemo(() => new Map((drafts ?? []).map((d) => [d.id, d])), [drafts]);
  const caseCount = useMemo(() => new Map(pool.map((d) => [d.id, progressTargets([d]).length])), [pool]);

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };
  const leaveOut = (next: Set<string>) => {
    setExcluded(next);
    storeLeftOutModules([...next]);
  };
  const scopedCases = scoped.reduce((n, d) => n + (caseCount.get(d.id) ?? 0), 0);

  if (loadError && !drafts) return <Notice tone="danger" title="Drafts could not be read">{loadError}</Notice>;
  if (!drafts) return <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading…</div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Progress"
        description="Bring outside testing into Spira: describe what you tested (WhatsApp-style), or upload a colleague's progress / issue spreadsheet. Gemini maps the work to In Scope cases; you confirm Pass, Fail or Blocked before anything is written. Reports then refresh on the current template."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {settingsReleaseLabel && <Badge tone="brand">{settingsReleaseLabel}</Badge>}
            {ai && <Badge tone={aiOn ? "brand" : "neutral"}>{aiOn ? <><Sparkles aria-hidden /> {ai.model}</> : "Gemini not configured"}</Badge>}
          </div>
        }
      />

      {inProject.length === 0 ? (
        <EmptyState icon={CircleCheckBig} title="Nothing to search yet" action={<ButtonLink href="/" variant="primary">Start a comparison</ButtonLink>}>
          Set the Testing cycle in Settings (UAT or SIT), then Compare that build&apos;s test sets. Once a module is completed (or still in review), its In Scope cases can be found and marked here.
        </EmptyState>
      ) : (
        <>
          {settingsReleaseId !== null && releaseMatchCount === 0 && (
            <Notice tone="warning" title={`No drafts yet for ${settingsReleaseLabel || "this build"}`}>
              Progress is still listing modules from other builds. Compare the UAT / current-release test sets on{" "}
              <Link href="/" className="font-medium underline">
                Compare
              </Link>
              , or turn off &quot;This build only&quot; below to use older drafts.
            </Notice>
          )}
          <Section
            icon={Layers}
            title="Where to look"
            description="Completed modules are the usual place to record weekly progress. Prefer the build chosen in Settings (Testing cycle); turn off filters to include other drafts."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {settingsReleaseId !== null && (
                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400">
                    <input type="checkbox" className="size-4 accent-brand-600" checked={releaseOnly} onChange={(e) => setReleaseOnly(e.target.checked)} />
                    This build only
                  </label>
                )}
                <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-zinc-400">
                  <input type="checkbox" className="size-4 accent-brand-600" checked={completedOnly} onChange={(e) => setCompletedOnly(e.target.checked)} />
                  Completed only
                </label>
                <Button size="sm" variant="ghost" disabled={scoped.length === pool.length} onClick={() => leaveOut(new Set([...excluded].filter((id) => !pool.some((d) => d.id === id))))}>
                  All
                </Button>
                <Button size="sm" variant="ghost" disabled={scoped.length === 0} onClick={() => leaveOut(new Set([...excluded, ...pool.map((d) => d.id)]))}>
                  None
                </Button>
                {projects.length > 1 && (
                  <select className="input w-auto text-xs" aria-label="Project" value={projectId ?? ""} onChange={(e) => setProject(Number(e.target.value))}>
                    {projects.map((id) => (
                      <option key={id} value={id}>
                        Project {id}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            }
          >
            {pool.length === 0 ? (
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                No completed modules in this project yet. Finish a live apply on{" "}
                <Link href="/drafts" className="font-medium underline">
                  Drafts
                </Link>
                , or turn off Completed only.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {pool.map((d) => {
                  const on = !excluded.has(d.id);
                  const n = caseCount.get(d.id) ?? 0;
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          const next = new Set(excluded);
                          if (on) next.add(d.id);
                          else next.delete(d.id);
                          leaveOut(next);
                        }}
                        className={clsx(
                          "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition",
                          on
                            ? "bg-slate-900 text-white ring-slate-900 dark:bg-white dark:text-zinc-900 dark:ring-white"
                            : "text-slate-600 ring-slate-200 hover:bg-slate-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/[0.04]",
                        )}
                      >
                        {d.module}
                        {!isCompleted(d.status) && <span className="opacity-70">draft</span>}
                        <span className={clsx("tabular-nums", on ? "opacity-70" : "text-slate-400")}>{n}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 text-xs text-slate-500">
              {scoped.length === 0
                ? "Choose at least one module."
                : `${plural(scoped.length, "module")}, ${plural(scopedCases, "In Scope case")} to search.`}
            </p>
          </Section>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <label className="flex min-w-[16rem] max-w-sm flex-col gap-1 text-sm">
              <span className="flex items-center gap-1.5 font-medium">
                <UserRound className="size-4 text-slate-400" aria-hidden /> Tester
              </span>
              <input className="input" placeholder="Your name, written on each run" value={tester} maxLength={100} onChange={(e) => changeTester(e.target.value)} />
            </label>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="How to bring results in">
              {(
                [
                  { id: "describe" as const, label: "Describe", icon: Search },
                  { id: "upload" as const, label: "Upload sheet", icon: FileSpreadsheet },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={mode === m.id}
                  onClick={() => setMode(m.id)}
                  className={clsx(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition",
                    mode === m.id
                      ? "bg-slate-900 text-white ring-slate-900 dark:bg-white dark:text-zinc-900 dark:ring-white"
                      : "text-slate-600 ring-slate-200 hover:bg-slate-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/[0.04]",
                  )}
                >
                  <m.icon className="size-3.5" aria-hidden />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {mode === "describe" ? (
            <Finder aiOn={aiOn} aiKnown={!!ai} drafts={scoped} draftsById={draftsById} tester={tester.trim()} siteUrl={spira?.siteUrl ?? null} projectId={projectId} onChanged={refresh} />
          ) : (
            <ImportPanel drafts={scoped} tester={tester.trim()} aiOn={aiOn} onChanged={refresh} />
          )}
        </>
      )}
    </div>
  );
}

function Finder({
  aiOn,
  aiKnown,
  drafts,
  draftsById,
  tester,
  siteUrl,
  projectId,
  onChanged,
}: {
  aiOn: boolean;
  aiKnown: boolean;
  drafts: Draft[];
  draftsById: Map<string, Draft>;
  tester: string;
  siteUrl: string | null;
  projectId: number | null;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<ProgressPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<ProgressSearch | null>(null);
  const [timing, setTiming] = useState<{ startedAt: number; tookMs: number | null } | null>(null);
  const [picks, setPicks] = useState<Record<string, boolean>>({});
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<{ done: number; total: number; stopping: boolean } | null>(null);
  const [outcome, setOutcome] = useState<PassProgressOutcome | null>(null);
  const stopRef = useRef(false);

  const searching = phase !== null;
  const idOf = (c: ProgressCase) => `${c.target.draftId}|${c.target.card.key}`;
  const statusOf = (c: ProgressCase) => currentStatus(c.target.card, draftsById.get(c.target.draftId)?.execution);

  async function find() {
    const description = text.trim();
    if (description.length < 10 || !aiOn || drafts.length === 0) return;
    setError(null);
    setOutcome(null);
    setSearch(null);
    setPicks({});
    setForce(false);
    setPhase({ stage: "understanding", modules: drafts.length });
    const startedAt = Date.now();
    setTiming({ startedAt, tookMs: null });
    try {
      const result = await searchProgress(drafts, description, setPhase);
      setTiming({ startedAt, tookMs: Date.now() - startedAt });
      setSearch(result);
      setPicks(Object.fromEntries(result.cases.map((c) => [idOf(c), defaultOn(statusOf(c), c.candidate.relevance)])));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase(null);
    }
  }

  const chosen = search ? search.cases.filter((c) => picks[idOf(c)]) : [];
  const changedSince = search !== null && text.trim() !== search.description;
  const canPass = chosen.length > 0 && !changedSince && !job && !searching;
  const modules = [...new Set(chosen.map((c) => c.target.module))];
  const comment = search?.analysis.summary ? `Progress: ${search.analysis.summary}` : search ? `Progress: ${clip(search.description, 120)}` : "";

  async function pass() {
    if (!search) return;
    setConfirming(false);
    stopRef.current = false;
    setJob({ done: 0, total: chosen.length, stopping: false });
    try {
      const out = await passProgress(
        chosen.map((c) => c.target),
        tester,
        comment,
        {
          force,
          onProgress: (done, total) => setJob((j) => (j ? { ...j, done, total } : j)),
          keepGoing: () => !stopRef.current,
        },
      );
      setOutcome(out);
      if (out.recorded > 0) {
        const done = new Set(out.results.filter((r) => r.result === "recorded").map((r) => `${r.testSetId}:${r.testSetTestCaseId}`));
        setPicks((prev) => Object.fromEntries(Object.entries(prev).map(([k, on]) => {
          const c = search.cases.find((x) => idOf(x) === k);
          return [k, c && done.has(`${c.target.card.testSetId}:${c.target.card.testSetTestCaseId}`) ? false : on];
        })));
      }
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setJob(null);
      onChanged();
    }
  }

  const groups = search
    ? [
        { id: "ready", title: "Still to run", hint: "Ticked when Gemini is at least medium sure; these get a Passed run in Spira.", cases: search.cases.filter((c) => statusOf(c) === null) },
        { id: "retest", title: "Already have a result", hint: "Failed, Blocked or Caution can be re-passed after a fix; Already Passed stays unticked unless you force a new run.", cases: search.cases.filter((c) => statusOf(c) !== null) },
      ]
    : [];

  return (
    <Section
      icon={CircleCheckBig}
      title="Record progress"
      description="Gemini works out which feature you covered, then picks the In Scope cases about that feature by context. You choose which to mark Passed; each gets a Passed run in Spira."
    >
      <div className="flex flex-col gap-4">
        {!aiOn && aiKnown && (
          <Notice tone="warning" title="Gemini is not configured on the server">
            Set GEMINI_API_KEY on the server to find the cases that cover the work you describe.
          </Notice>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="progress-text" className="text-sm font-medium">
            What did you test?
          </label>
          <textarea
            id="progress-text"
            className="input min-h-24"
            placeholder={EXAMPLE}
            value={text}
            maxLength={MAX_PROGRESS_TEXT}
            disabled={searching || !!job}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void find();
              }
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              Name the feature or journey and the platform when it matters. <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> searches.
            </p>
            <Button variant="primary" icon={Search} busy={searching} disabled={!aiOn || text.trim().length < 10 || drafts.length === 0 || !!job} onClick={() => void find()}>
              Find related cases
            </Button>
          </div>
        </div>

        {phase && (
          <Notice tone="info" title={phaseText(phase)} action={timing && <Elapsed since={timing.startedAt} />}>
            Nothing is written to Spira until you confirm Passed runs below.
          </Notice>
        )}
        {error && <Notice tone="danger" title="The search could not finish">{error}</Notice>}
        {search?.unreadError && (
          <Notice tone="warning" title={search.understood ? "Part of the search could not finish" : "Gemini could not work out the feature"}>
            {search.unreadError}{" "}
            <button type="button" className="font-medium underline" onClick={() => void find()}>
              Search again
            </button>
          </Notice>
        )}
        {search?.analysis.question && (
          <Notice tone="warning" title="Add a little more detail">
            {search.analysis.question}
          </Notice>
        )}

        {outcome && !job && (
          <Notice
            tone={outcome.failed.length && outcome.recorded === 0 ? "danger" : outcome.failed.length ? "warning" : "success"}
            title={outcome.recorded === 0 ? "No case was marked Passed" : `${plural(outcome.recorded, "case")} marked Passed in Spira`}
            action={<Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>Dismiss</Button>}
          >
            <ul className="flex flex-col gap-1">
              {outcome.recorded > 0 && <li>Each got a Passed run{tester ? `, tested by ${tester}` : ""}. Open Reports and generate again for the latest figures.</li>}
              {outcome.failed.length > 0 && (
                <li>
                  {plural(outcome.failed.length, "case")} not recorded:
                  <ul className="mt-1 list-disc pl-5 text-xs">
                    {outcome.failed.slice(0, 8).map((f) => (
                      <li key={`${f.target.draftId}|${f.target.card.key}`}>
                        TC{f.target.card.testCaseId} ({f.target.module}): {f.message}
                      </li>
                    ))}
                    {outcome.failed.length > 8 && <li>and {outcome.failed.length - 8} more</li>}
                  </ul>
                </li>
              )}
            </ul>
          </Notice>
        )}

        {search && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-slate-50 px-4 py-3 dark:bg-white/[0.03]">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {search.analysis.feature || search.analysis.area || "Covered work"}
                  {search.analysis.related.length > 0 && <span className="font-normal text-slate-500"> · {search.analysis.related.slice(0, 6).join(", ")}</span>}
                </p>
                {search.analysis.summary && <p className="mt-0.5 text-xs text-slate-600 dark:text-zinc-400">{search.analysis.summary}</p>}
                <p className="mt-1 text-xs text-slate-500">
                  {plural(search.cases.length, "related case")} from {plural(search.searched, "case")} in {plural(search.modules, "module")}
                  {timing?.tookMs != null ? ` · ${(timing.tookMs / 1000).toFixed(1)}s` : ""}
                </p>
              </div>
              <Button size="sm" variant="ghost" icon={RefreshCw} disabled={searching || !!job} onClick={() => void find()}>
                Search again
              </Button>
            </div>

            {changedSince && (
              <Notice tone="warning" title="You changed the description">
                Search again before marking Passed, so the cases match what you wrote.
              </Notice>
            )}

            {search.cases.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">No related In Scope cases in the chosen modules. Try a clearer feature name, or include more modules.</p>
            ) : (
              groups
                .filter((g) => g.cases.length > 0)
                .map((g) => (
                  <div key={g.id} className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {g.title} <span className="font-normal text-slate-500">({g.cases.length})</span>
                      </h3>
                      <p className="text-xs text-slate-500">{g.hint}</p>
                    </div>
                    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-white/[0.06] dark:border-white/10">
                      {g.cases.map((c) => {
                        const id = idOf(c);
                        const status = statusOf(c);
                        const draft = draftsById.get(c.target.draftId);
                        return (
                          <li key={id} className="flex items-start gap-3 px-3 py-2.5">
                            <input
                              type="checkbox"
                              className="mt-1 size-4 accent-brand-600"
                              checked={!!picks[id]}
                              disabled={!!job}
                              onChange={(e) => setPicks((prev) => ({ ...prev, [id]: e.target.checked }))}
                              aria-label={`Mark TC${c.target.card.testCaseId} Passed`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs text-slate-500">TC{c.target.card.testCaseId}</span>
                                <span className="text-sm font-medium">{c.target.card.name}</span>
                                <Badge tone={RELEVANCE_TONE[c.candidate.relevance]}>{c.candidate.relevance}</Badge>
                                <StatusChip status={status} className="shrink-0" />
                              </div>
                              <p className="mt-0.5 text-xs text-slate-500">
                                {c.target.module}
                                {drafts.length > 1 && draft ? (
                                  <>
                                    {" · "}
                                    <Link href={`/drafts/${c.target.draftId}/execute`} className="font-medium hover:underline">
                                      Execute
                                    </Link>
                                  </>
                                ) : null}
                                {siteUrl && projectId != null && (
                                  <>
                                    {" · "}
                                    <a
                                      href={`${siteUrl}/${projectId}/TestCase/${c.target.card.testCaseId}.aspx`}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      className="font-medium text-brand-700 hover:underline dark:text-brand-300"
                                    >
                                      Open in Spira
                                    </a>
                                  </>
                                )}
                              </p>
                              {status === "passed" && picks[id] && !force && (
                                <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">Already Passed; turn on Force below to record a newer run.</p>
                              )}
                              {status && status !== "passed" && picks[id] && (
                                <p className="mt-0.5 text-xs text-slate-500">Currently {STATUS_LABEL[status]} in Spira; this records a newer Passed run.</p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
            )}

            {search.cases.length > 0 && (
              <div className="flex flex-col gap-3 rounded-xl bg-slate-50 p-4 dark:bg-white/[0.03]">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={force} disabled={!!job} onChange={(e) => setForce(e.target.checked)} />
                  <span>
                    <span className="font-medium">Force a new Passed run on cases already Passed</span>
                    <span className="block text-xs text-slate-500">Leave off unless you re-ran them and want a fresh run in Spira.</span>
                  </span>
                </label>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-600 dark:text-zinc-400">
                    {chosen.length === 0
                      ? "Tick the cases to mark Passed."
                      : `${plural(chosen.length, "case")} in ${modules.join(", ")}${tester ? `, tested by ${tester}` : ""}. Comment on each run: ${clip(comment, 80)}.`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!job || search.cases.every((c) => picks[idOf(c)])}
                      onClick={() => setPicks(Object.fromEntries(search.cases.map((c) => [idOf(c), true])))}
                    >
                      Tick all
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!!job || chosen.length === 0} onClick={() => setPicks(Object.fromEntries(search.cases.map((c) => [idOf(c), false])))}>
                      Clear
                    </Button>
                    <Button variant="primary" icon={Check} disabled={!canPass} onClick={() => setConfirming(true)}>
                      Mark {chosen.length || ""} Passed
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {job && (
          <Notice
            tone="info"
            title={`Recording Passed: ${job.done} of ${job.total}${job.stopping ? " (stopping after this batch)" : ""}`}
            action={
              <Button
                size="sm"
                icon={Square}
                disabled={job.stopping}
                onClick={() => {
                  stopRef.current = true;
                  setJob((j) => (j ? { ...j, stopping: true } : j));
                }}
              >
                Stop
              </Button>
            }
          >
            <ProgressBar value={job.done} max={Math.max(1, job.total)} />
            <p className="mt-1.5 text-xs">Each case gets a Passed run in Spira with every step Passed, in batches.</p>
          </Notice>
        )}
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Mark ${plural(chosen.length, "case")} Passed in Spira?`}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" icon={Check} disabled={!canPass} onClick={() => void pass()}>
              Record {chosen.length} Passed
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            This writes to Spira: {plural(chosen.length, "Passed test run")} in {plural(modules.length, "module")}
            {tester ? `, tested by ${tester}` : ""}. Cases already Passed are {force ? "given a newer Passed run" : "skipped unless Force is on"}.
          </p>
          {search?.analysis.summary && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-white/[0.04]">Run comment: Progress: {search.analysis.summary}</p>}
          <ul className="max-h-56 overflow-y-auto text-xs">
            {modules.map((name) => (
              <li key={name} className="py-1">
                <span className="font-semibold">{name}</span>
                <ul>
                  {chosen
                    .filter((c) => c.target.module === name)
                    .map((c) => {
                      const status = statusOf(c);
                      return (
                        <li key={idOf(c)} className="py-0.5 pl-3">
                          <span className="font-mono">TC{c.target.card.testCaseId}</span> {clip(c.target.card.name, 70)}
                          {status && <span className="text-slate-500"> ({STATUS_LABEL[status]} now)</span>}
                        </li>
                      );
                    })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    </Section>
  );
}
