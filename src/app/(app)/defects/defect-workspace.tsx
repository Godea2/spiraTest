"use client";

import clsx from "clsx";
import { ArrowRight, Bug, ChevronDown, ExternalLink, Layers, Quote, RefreshCw, Search, Sparkles, Square, Undo2, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Notice, PageHeader, ProgressBar, Section, Spinner, Switch } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import {
  adoptDraftDefects,
  listDefects,
  logIncident,
  raiseDefect,
  readIncidentOptions,
  searchDefect,
  undoDefect,
  type DefectCase,
  type DefectSearch,
  type IncidentFields,
  type RaiseOutcome,
  type SearchPhase,
} from "@/lib/client/defects";
import { allDrafts } from "@/lib/client/drafts";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import { formatDateTime } from "@/lib/client/format";
import { effectiveColumn, isCompleted } from "@/lib/domain/board";
import { defectTargets, MAX_DEFECT_TEXT, pickBySeverity } from "@/lib/domain/defects";
import { currentStatus, STATUS_LABEL } from "@/lib/domain/execution";
import { COLUMN_LABELS, type BlockedConfidence, type Column, type DefectRecord, type Draft, type IncidentOptions } from "@/lib/domain/types";
import { COLUMN_STYLE } from "../drafts/[id]/board-parts";
import { StatusChip } from "../drafts/[id]/execute/runner";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CONFIDENCE_TONE: Record<BlockedConfidence, "danger" | "warning" | "neutral"> = { high: "danger", medium: "warning", low: "neutral" };

const EXAMPLE = 'For example: On the Login screen, "Continue with phone number" stays enabled when the phone number field is empty, and tapping it opens the OTP screen.';

type Pick = { on: boolean; stepLabel: string | null };

function phaseText(phase: SearchPhase): string {
  if (phase.stage === "reading") return `Gemini is reading ${plural(phase.total, "case name")} across ${plural(phase.modules, "module")} for the defect…`;
  if (phase.stage === "steps") return `Reading the steps of ${plural(phase.total, "likely case")} from Spira (${phase.done} of ${phase.total})…`;
  return `Checking each case's steps against the defect (${phase.done} of ${phase.total})…`;
}

/** Where a case goes when it is failed for a defect. */
function moveNote(column: Column, completed: boolean): string | null {
  if (column === "defects") return null;
  if (column === "outOfScope") return "Out of Scope now: moves to Defects, so live apply keeps it in its test set.";
  if (column === "needsReview") return "Needs Review now: moves to Defects, which settles it as kept.";
  if (column === "blocked") return `Blocked now: moves to Defects${completed ? "; its Blocked sign-off stays in Spira's history" : ""}.`;
  return "Moves from In Scope to Defects.";
}

export function DefectWorkspace({ from }: { from: string | null }) {
  const { settings, ai, spira } = useSettings();
  const aiOn = !!ai?.configured;
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [records, setRecords] = useState<DefectRecord[]>([]);
  const [pickedProject, setProject] = useState<number | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [tester, setTester] = useState("");

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
      .then(() => {
        try {
          adoptDraftDefects();
        } catch {
          // Older defects stay in their drafts and are moved on the next visit.
        }
        return allDrafts();
      })
      .then(
        (all) => {
          if (!active) return;
          setDrafts(all);
          setTester(getTester());
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
    const opened = drafts?.find((d) => d.id === from);
    if (opened && projects.includes(opened.projectId)) return opened.projectId;
    if (settingsProject !== null && projects.includes(settingsProject)) return settingsProject;
    return projects[0] ?? null;
  }, [pickedProject, projects, drafts, from, settingsProject]);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => active && projectId !== null && setRecords(listDefects(projectId)));
    return () => {
      active = false;
    };
  }, [projectId, drafts]);

  const inProject = useMemo(() => (drafts ?? []).filter((d) => d.projectId === projectId && d.testSets.length > 0), [drafts, projectId]);
  const scoped = useMemo(() => inProject.filter((d) => !excluded.has(d.id)), [inProject, excluded]);
  const draftsById = useMemo(() => new Map((drafts ?? []).map((d) => [d.id, d])), [drafts]);
  const caseCount = useMemo(() => new Map(inProject.map((d) => [d.id, defectTargets([d]).length])), [inProject]);

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };

  if (loadError && !drafts) return <Notice tone="danger" title="Drafts could not be read">{loadError}</Notice>;
  if (!drafts) return <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading…</div>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Defects"
        description="Describe a defect once. Gemini looks for the cases it breaks in every module you compared, Draft or Completed, including Out of Scope cases that have not been removed yet. The cases you choose move to their board's Defects column, are failed in Spira and linked to one incident."
        actions={ai && <Badge tone={aiOn ? "brand" : "neutral"}>{aiOn ? <><Sparkles aria-hidden /> {ai.model}</> : "Gemini not configured"}</Badge>}
      />

      {inProject.length === 0 ? (
        <EmptyState icon={Bug} title="Nothing to search yet" action={<ButtonLink href="/" variant="primary">Start a comparison</ButtonLink>}>
          Compare a module with its Spira test sets first. Its cases can then be searched for defects here, before or after the live apply.
        </EmptyState>
      ) : (
        <>
          <Section
            icon={Layers}
            title="Where to look"
            description="A defect can show up in more than one module. Every compared module is searched unless you leave it out."
            actions={
              projects.length > 1 && (
                <select className="input w-auto" aria-label="Spira project" value={projectId ?? ""} onChange={(e) => { setProject(Number(e.target.value)); setExcluded(new Set()); }}>
                  {projects.map((p) => <option key={p} value={p}>Project {p}</option>)}
                </select>
              )
            }
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                {inProject.map((d) => {
                  const on = !excluded.has(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setExcluded((prev) => { const next = new Set(prev); if (on) next.add(d.id); else next.delete(d.id); return next; })}
                      className={clsx(
                        "flex cursor-pointer flex-col items-start rounded-xl px-3 py-2 text-left ring-1 ring-inset transition",
                        on ? "bg-brand-50 ring-brand-300 dark:bg-brand-500/10 dark:ring-brand-400/40" : "opacity-60 ring-slate-200 hover:opacity-100 dark:ring-white/10",
                        d.id === from && "outline-2 outline-offset-2 outline-brand-400",
                      )}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <input type="checkbox" readOnly tabIndex={-1} checked={on} className="size-3.5 accent-brand-600" aria-hidden />
                        {d.module}
                        <Badge tone={isCompleted(d.status) ? "success" : "neutral"}>{isCompleted(d.status) ? "Completed" : "Draft"}</Badge>
                      </span>
                      <span className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
                        {clip(d.name, 40)} · {plural(caseCount.get(d.id) ?? 0, "case")}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Completed modules: the cases still in Spira (In Scope, Defects and Blocked). Drafts: every case, so a defect in an Out of Scope case is caught before live apply removes it. A case on two drafts is searched once.
                </p>
                <label className="flex min-w-[16rem] flex-col gap-1 text-sm">
                  <span className="flex items-center gap-1.5 font-medium"><UserRound className="size-4 text-slate-400" aria-hidden /> Tester</span>
                  <input className="input" placeholder="Your name, written on each run" value={tester} maxLength={100} onChange={(e) => changeTester(e.target.value)} />
                </label>
              </div>
            </div>
          </Section>

          {projectId !== null && (
            <Finder
              key={projectId}
              projectId={projectId}
              drafts={scoped}
              draftsById={draftsById}
              tester={tester.trim()}
              aiOn={aiOn}
              aiKnown={!!ai}
              siteUrl={spira?.siteUrl ?? null}
              onChanged={refresh}
            />
          )}
        </>
      )}

      {projectId !== null && <DefectLog records={records} draftsById={draftsById} projectId={projectId} siteUrl={spira?.siteUrl ?? null} onChanged={refresh} />}
    </div>
  );
}

function Finder({
  projectId,
  drafts,
  draftsById,
  tester,
  aiOn,
  aiKnown,
  siteUrl,
  onChanged,
}: {
  projectId: number;
  drafts: Draft[];
  draftsById: Map<string, Draft>;
  tester: string;
  aiOn: boolean;
  aiKnown: boolean;
  siteUrl: string | null;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<SearchPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<DefectSearch | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState<IncidentOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [fields, setFields] = useState<IncidentFields>({ typeId: null, priorityId: null, severityId: null });
  const [passBefore, setPassBefore] = useState(true);
  const [logInSpira, setLogInSpira] = useState(true);
  const [showUnaffected, setShowUnaffected] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<{ done: number; total: number; stopping: boolean } | null>(null);
  const [outcome, setOutcome] = useState<RaiseOutcome | null>(null);
  const [retrying, setRetrying] = useState(false);
  const stopRef = useRef(false);

  const searching = phase !== null;
  const incidentUrl = (incidentId: number) => (siteUrl ? `${siteUrl}/${projectId}/Incident/${incidentId}.aspx` : null);
  const idOf = (c: DefectCase) => `${c.target.draftId}|${c.target.card.key}`;

  async function find() {
    const description = text.trim();
    if (description.length < 10 || !aiOn || drafts.length === 0) return;
    setError(null);
    setOutcome(null);
    setShowUnaffected(false);
    setPhase({ stage: "reading", total: 0, modules: drafts.length });
    try {
      const result = await searchDefect(drafts, description, setPhase);
      setSearch(result);
      setPicks(Object.fromEntries(result.cases.map((c) => [idOf(c), { on: c.match.verdict === "fails", stepLabel: c.match.stepLabel }])));
      setTitle(result.analysis.title);
      void loadOptions(result.analysis.severity);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase(null);
    }
  }

  async function loadOptions(severity: string) {
    setOptionsError(null);
    try {
      const o = await readIncidentOptions(projectId);
      setOptions(o);
      const type = o.types.find((t) => /bug|defect/i.test(t.name)) ?? o.types.find((t) => t.id === o.defaultTypeId) ?? null;
      setFields({ typeId: type?.id ?? null, priorityId: pickBySeverity(o.priorities, severity)?.id ?? null, severityId: pickBySeverity(o.severities, severity)?.id ?? null });
    } catch (err) {
      setOptionsError(errorMessage(err));
    }
  }

  const columnOf = (c: DefectCase): Column => {
    const draft = draftsById.get(c.target.draftId);
    const card = draft?.testSets.flatMap((s) => s.cards).find((k) => k.key === c.target.card.key);
    return draft && card ? effectiveColumn(card, draft.decisions) : c.target.column;
  };
  const chosen = search ? search.cases.filter((c) => picks[idOf(c)]?.on) : [];
  const needsStep = chosen.filter((c) => c.steps.length > 0 && !picks[idOf(c)]?.stepLabel);
  const changedSince = search !== null && text.trim() !== search.description;
  const canRaise = chosen.length > 0 && needsStep.length === 0 && !changedSince && title.trim().length >= 3 && !job;
  const chosenModules = [...new Set(chosen.map((c) => c.target.module))];
  const moving = chosen.filter((c) => columnOf(c) !== "defects");
  const recheck = [...new Set(moving.filter((c) => !draftsById.get(c.target.draftId) || !isCompleted(draftsById.get(c.target.draftId)!.status)).map((c) => c.target.module))];

  const setPick = (id: string, change: Partial<Pick>) => setPicks((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { on: false, stepLabel: null }), ...change } }));

  async function raise() {
    if (!search) return;
    setConfirming(false);
    stopRef.current = false;
    setJob({ done: 0, total: chosen.length, stopping: false });
    try {
      const out = await raiseDefect(
        {
          picks: chosen.map((c) => ({ target: c.target, steps: c.steps, stepLabel: picks[idOf(c)]?.stepLabel ?? null })),
          description: search.description,
          title,
          expected: search.analysis.expected,
          passBefore,
          logIncident: logInSpira,
          fields,
        },
        tester,
        { onProgress: (done, total) => setJob((j) => (j ? { ...j, done, total } : j)), keepGoing: () => !stopRef.current },
      );
      setOutcome(out);
      if (out.record) {
        const done = new Set(out.record.cases.map((c) => `${c.draftId}|${c.testSetId}:${c.testSetTestCaseId}`));
        setPicks((prev) => Object.fromEntries(Object.entries(prev).map(([k, p]) => [k, done.has(k) ? { ...p, on: false } : p])));
        if (out.failed.length === 0) {
          setSearch(null);
          setText("");
        }
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setJob(null);
      onChanged();
    }
  }

  async function retryIncident(defectId: string) {
    setRetrying(true);
    try {
      const out = await logIncident(defectId, fields);
      setOutcome((o) => (o?.record?.id === defectId ? { ...o, record: out.record, incident: out.incident, incidentError: null } : o));
      toast.success(`Logged as incident ${out.incident.incidentId}, linked to ${plural(out.incident.linked.length, "failed run")}`);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRetrying(false);
    }
  }

  const groups = search
    ? [
        { id: "fails", title: "Fails because of this defect", hint: "Checked against their steps; the quoted words are in the case.", cases: search.cases.filter((c) => c.match.verdict === "fails") },
        { id: "possible", title: "Might be affected", hint: "Not ticked: look at the step and tick the ones that really fail.", cases: search.cases.filter((c) => c.match.verdict === "possible") },
      ]
    : [];
  const unaffected = search?.cases.filter((c) => c.match.verdict === "unaffected") ?? [];

  return (
    <Section
      icon={Bug}
      title="Find a defect"
      description="Gemini picks the likely cases from their names, then checks each one against its steps in Spira, naming the failing step and quoting the case. You choose which to fail."
    >
      <div className="flex flex-col gap-4">
        {!aiOn && aiKnown && (
          <Notice tone="warning" title="Gemini is not configured on the server">
            Set GEMINI_API_KEY on the server to search for the cases a defect affects.
          </Notice>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="defect-text" className="text-sm font-medium">What went wrong?</label>
          <textarea
            id="defect-text"
            className="input min-h-24"
            placeholder={EXAMPLE}
            value={text}
            maxLength={MAX_DEFECT_TEXT}
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
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Name the screen, the action and what happened. Searches {plural(drafts.length, "module")}. <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> searches.
            </p>
            <Button variant="primary" icon={Search} busy={searching} disabled={!aiOn || text.trim().length < 10 || drafts.length === 0 || !!job} onClick={() => void find()}>
              {search ? "Search again" : "Find affected cases"}
            </Button>
          </div>
        </div>

        {phase && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-white/[0.03]">
            <span>{phaseText(phase)}</span>
            <ProgressBar value={phase.stage === "reading" ? 1 : phase.done} max={phase.stage === "reading" ? 3 : Math.max(1, phase.total)} />
          </div>
        )}
        {error && <Notice tone="danger" title="The search did not finish">{error}</Notice>}

        {outcome && !job && <OutcomeNotice outcome={outcome} incidentUrl={incidentUrl} retrying={retrying} onRetry={(id) => void retryIncident(id)} onDismiss={() => setOutcome(null)} />}

        {search && !searching && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-slate-200 px-4 py-3 text-sm dark:border-white/10">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-zinc-400">Gemini reads this as</p>
              <p className="mt-1">
                <span className="font-medium">{search.analysis.area || "Unknown area"}</span>
                {search.analysis.symptom && <> · {search.analysis.symptom}</>}
              </p>
              {search.analysis.expected && <p className="mt-0.5 text-slate-600 dark:text-zinc-400">Expected: {search.analysis.expected}</p>}
              <p className="mt-1.5 text-xs text-slate-500 dark:text-zinc-400">
                Read {plural(search.searched, "case name")} in {plural(search.modules, "module")}, checked the steps of {plural(search.cases.length, "likely case")}. Suggested severity: {search.analysis.severity}.
              </p>
            </div>
            {search.analysis.question && (
              <Notice tone="warning" title="To sharpen the search">
                {search.analysis.question} Add the answer to the description and search again.
              </Notice>
            )}
            {changedSince && (
              <Notice tone="warning" title="The description changed since this search">
                Search again, so the cases match what the defect says; their runs record this description.
              </Notice>
            )}

            {search.cases.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-500">No case looks affected by this defect. Add the screen or action and search again.</p>
            ) : (
              groups.map((g) =>
                g.cases.length === 0 ? null : (
                  <div key={g.id}>
                    <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-sm font-semibold">
                        {g.title} <span className="font-normal text-slate-400">{g.cases.length}</span>
                      </h3>
                      <span className="text-xs text-slate-500 dark:text-zinc-400">{g.hint}</span>
                    </div>
                    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-3 dark:divide-white/[0.06] dark:border-white/10">
                      {g.cases.map((c) => (
                        <CaseRow
                          key={idOf(c)}
                          item={c}
                          draft={draftsById.get(c.target.draftId) ?? null}
                          column={columnOf(c)}
                          pick={picks[idOf(c)] ?? { on: false, stepLabel: null }}
                          onPick={(change) => setPick(idOf(c), change)}
                          disabled={!!job}
                        />
                      ))}
                    </ul>
                  </div>
                ),
              )
            )}
            {unaffected.length > 0 && (
              <div>
                <button type="button" className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-white" onClick={() => setShowUnaffected((v) => !v)}>
                  {showUnaffected ? "Hide" : "Show"} {plural(unaffected.length, "case")} checked and not affected
                </button>
                {showUnaffected && (
                  <ul className="mt-1 flex flex-col gap-1 text-xs text-slate-600 dark:text-zinc-400">
                    {unaffected.map((c) => (
                      <li key={idOf(c)}>
                        <span className="font-mono">TC{c.target.card.testCaseId}</span> {c.target.card.name} <span className="text-slate-400">({c.target.module})</span>: {c.match.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {search.cases.length > unaffected.length && (
              <div className="flex flex-col gap-4 rounded-xl bg-slate-50 p-4 dark:bg-white/[0.03]">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Defect title</span>
                  <input className="input" value={title} maxLength={255} onChange={(e) => setTitle(e.target.value)} />
                </label>
                {logInSpira && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <OptionSelect label="Type" list={options?.types} value={fields.typeId} onChange={(typeId) => setFields((f) => ({ ...f, typeId }))} />
                    <OptionSelect label="Severity" list={options?.severities} value={fields.severityId} onChange={(severityId) => setFields((f) => ({ ...f, severityId }))} />
                    <OptionSelect label="Priority" list={options?.priorities} value={fields.priorityId} onChange={(priorityId) => setFields((f) => ({ ...f, priorityId }))} />
                  </div>
                )}
                {logInSpira && optionsError && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Spira&apos;s incident lists could not be read ({optionsError}); the defect gets Spira&apos;s defaults.{" "}
                    <button type="button" className="font-medium underline" onClick={() => void loadOptions(search.analysis.severity)}>Try again</button>
                  </p>
                )}
                <Switch checked={passBefore} onChange={setPassBefore} label="Mark the steps before the failing step as Passed" description="The tester went through them to reach the defect. Steps after it stay Not Run." />
                <Switch checked={logInSpira} onChange={setLogInSpira} label="Log the defect in Spira" description="One incident, linked to the failed step of every run in every module, with steps to reproduce." />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-600 dark:text-zinc-400">
                    {needsStep.length > 0
                      ? `Choose the failing step for ${plural(needsStep.length, "ticked case")}.`
                      : chosen.length
                        ? `${plural(chosen.length, "case")} in ${chosenModules.join(", ")}. Your description becomes the actual result on each failing step${tester ? `, tested by ${tester}` : ""}.`
                        : "Tick the cases to fail."}
                  </p>
                  <Button variant="danger" icon={Bug} disabled={!canRaise} onClick={() => setConfirming(true)}>
                    Fail {plural(chosen.length, "case")}
                    {logInSpira ? " & log defect" : ""}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {job && (
          <Notice
            tone="info"
            title={`Failing cases in Spira: ${job.done} of ${job.total}${job.stopping ? " (stopping after this batch)" : ""}`}
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
            <ProgressBar value={job.done} max={Math.max(1, job.total)} tone="danger" />
            {logInSpira && <p className="mt-1.5 text-xs">The defect is logged once the runs are saved.</p>}
          </Notice>
        )}
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Fail ${plural(chosen.length, "case")} for this defect?`}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" icon={Bug} onClick={() => void raise()}>
              Fail {chosen.length}
              {logInSpira ? " & log defect" : ""}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            This writes to Spira: {plural(chosen.length, "Failed test run")} in {plural(chosenModules.length, "module")}
            {logInSpira ? ", and one incident linked to them" : ""}. It can be undone from the defect list below.
          </p>
          {moving.length > 0 && (
            <p className="text-sm">
              {plural(moving.length, "card")} move{moving.length === 1 ? "s" : ""} to the Defects column of {moving.length === 1 ? "its" : "their"} board, which keeps {moving.length === 1 ? "it" : "them"} in the test set.
              {recheck.length > 0 && <> Before the live apply of {recheck.join(", ")}, run the membership check again: moving cards asks for a fresh one.</>}
            </p>
          )}
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs whitespace-pre-wrap dark:bg-white/[0.04]">{search?.description}</p>
          <ul className="max-h-56 overflow-y-auto text-xs">
            {chosenModules.map((name) => (
              <li key={name} className="py-1">
                <span className="font-semibold">{name}</span>
                <ul>
                  {chosen
                    .filter((c) => c.target.module === name)
                    .map((c) => {
                      const status = currentStatus(c.target.card, draftsById.get(c.target.draftId)?.execution);
                      const label = picks[idOf(c)]?.stepLabel;
                      const column = columnOf(c);
                      return (
                        <li key={idOf(c)} className="py-0.5 pl-3">
                          <span className="font-mono">TC{c.target.card.testCaseId}</span> {clip(c.target.card.name, 70)}
                          {label ? `, fails at step ${label}` : ", whole case"}
                          {column !== "defects" && <span className="text-slate-500"> ({COLUMN_LABELS[column]} → Defects)</span>}
                          {status === "passed" && <span className="text-amber-700 dark:text-amber-300"> (Passed now)</span>}
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

function CaseRow({ item, draft, column, pick, onPick, disabled }: { item: DefectCase; draft: Draft | null; column: Column; pick: Pick; onPick: (change: Partial<Pick>) => void; disabled: boolean }) {
  const { target, steps, match } = item;
  const { card } = target;
  const status = currentStatus(card, draft?.execution);
  const step = steps.find((s) => s.label === pick.stepLabel);
  const style = COLUMN_STYLE[column];
  const ColumnIcon = style.icon;
  const note = moveNote(column, target.completed);
  return (
    <li className="flex gap-3 py-3">
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-red-600" aria-label={`Fail TC${card.testCaseId}`} checked={pick.on} disabled={disabled || !draft} onChange={(e) => onPick({ on: e.target.checked })} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-500">TC{card.testCaseId}</span>
          <span className="text-sm font-medium">{card.name}</span>
          <Badge tone={CONFIDENCE_TONE[match.confidence]}>{match.confidence} confidence</Badge>
          <StatusChip status={status} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Link href={`/drafts/${target.draftId}`} className="font-medium text-slate-700 hover:underline dark:text-zinc-200">{target.module}</Link>
          <span className="text-slate-400">·</span>
          <span className="text-slate-500 dark:text-zinc-400">{target.testSetName}</span>
          <span className={clsx("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset", style.chip)}>
            <ColumnIcon className="size-3" aria-hidden /> {COLUMN_LABELS[column]}
          </span>
          {!target.completed && <Badge>Draft</Badge>}
        </div>
        <p className="text-xs text-slate-600 dark:text-zinc-400">{match.reason}</p>
        {match.evidence && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs">
            <Quote className="size-3 text-slate-400" aria-hidden />
            <span className="italic">{match.evidence}</span>
            {match.grounded ? <Badge tone="success">Found in the case</Badge> : <Badge tone="warning">Not found in the case</Badge>}
          </p>
        )}
        {steps.length > 0 ? (
          <div className="flex flex-col gap-1">
            <select
              className={clsx("input h-8 py-0 text-xs", pick.on && !pick.stepLabel && "ring-2 ring-amber-400")}
              aria-label={`Failing step of TC${card.testCaseId}`}
              value={pick.stepLabel ?? ""}
              disabled={disabled}
              onChange={(e) => onPick({ stepLabel: e.target.value || null, ...(e.target.value ? { on: true } : {}) })}
            >
              <option value="">Choose the failing step</option>
              {steps.map((s) => (
                <option key={s.label} value={s.label}>
                  Step {s.label}: {clip(s.step.description || (s.step.linkedTestCaseId ? `Calls TC${s.step.linkedTestCaseId}` : "(no action)"), 80)}
                </option>
              ))}
            </select>
            {step?.step.expectedResult && <p className="text-xs text-slate-500 dark:text-zinc-400">Expected at this step: {clip(step.step.expectedResult, 200)}</p>}
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-zinc-400">No steps in Spira: the whole case is recorded as Failed with your description.</p>
        )}
        {pick.on && note && <p className="text-xs text-violet-700 dark:text-violet-300">{note}</p>}
        {pick.on && status === "passed" && <p className="text-xs text-amber-700 dark:text-amber-300">Passed in Spira now; this records a newer Failed run.</p>}
        {pick.on && status === "failed" && <p className="text-xs text-slate-500">Already Failed in Spira; a new run is added and linked to this defect.</p>}
        {pick.on && status && status !== "passed" && status !== "failed" && <p className="text-xs text-slate-500">{STATUS_LABEL[status]} in Spira now; this records a newer Failed run.</p>}
        {!draft && <p className="text-xs text-red-600">Its draft was deleted.</p>}
      </div>
    </li>
  );
}

function OptionSelect({ label, list, value, onChange }: { label: string; list: IncidentOptions["types"] | undefined; value: number | null; onChange: (id: number | null) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select className="input" value={value ?? ""} disabled={!list} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{list ? "Spira default" : "Loading…"}</option>
        {(list ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function OutcomeNotice({
  outcome,
  incidentUrl,
  retrying,
  onRetry,
  onDismiss,
}: {
  outcome: RaiseOutcome;
  incidentUrl: (id: number) => string | null;
  retrying: boolean;
  onRetry: (defectId: string) => void;
  onDismiss: () => void;
}) {
  const recorded = outcome.record?.cases.length ?? 0;
  const problems = outcome.failed.length > 0 || outcome.incidentError !== null || (outcome.incident?.unlinked.length ?? 0) > 0;
  const url = outcome.incident ? incidentUrl(outcome.incident.incidentId) : null;
  const recheck = outcome.moved.filter((m) => !m.completed);
  return (
    <Notice
      tone={recorded === 0 ? "danger" : problems ? "warning" : "success"}
      title={recorded === 0 ? "No case was failed" : `${plural(recorded, "case")} failed in Spira${outcome.incident ? `, logged as incident ${outcome.incident.incidentId}` : ""}`}
      action={<Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
    >
      <ul className="flex flex-col gap-1">
        {outcome.incident && (
          <li>
            The incident is linked to the failed step of {plural(outcome.incident.linked.length, "run")}.{" "}
            {url && (
              <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium underline">
                Open IN:{outcome.incident.incidentId} in Spira <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </li>
        )}
        {outcome.moved.length > 0 && (
          <li>
            Moved to Defects: {outcome.moved.map((m) => `${m.count} in ${m.module}`).join(", ")}.
            {recheck.length > 0 && <> Run the membership check again before the live apply of {recheck.map((m) => m.module).join(", ")}.</>}
          </li>
        )}
        {outcome.incident?.unlinked.map((u) => <li key={u.testRunId}>{u.message}</li>)}
        {outcome.incidentError && outcome.record && (
          <li className="flex flex-wrap items-center gap-2">
            The defect was not logged: {outcome.incidentError}
            <Button size="sm" icon={RefreshCw} busy={retrying} onClick={() => onRetry(outcome.record!.id)}>
              Log it again
            </Button>
          </li>
        )}
        {outcome.failed.length > 0 && (
          <li>
            {plural(outcome.failed.length, "case")} not failed; they stay ticked so you can try again:
            <ul className="mt-1 list-disc pl-5 text-xs">
              {outcome.failed.slice(0, 6).map((f) => (
                <li key={`${f.target.draftId}|${f.target.card.key}`}>
                  TC{f.target.card.testCaseId} ({f.target.module}): {f.message}
                </li>
              ))}
              {outcome.failed.length > 6 && <li>and {outcome.failed.length - 6} more</li>}
            </ul>
          </li>
        )}
      </ul>
    </Notice>
  );
}

function DefectLog({
  records,
  draftsById,
  projectId,
  siteUrl,
  onChanged,
}: {
  records: DefectRecord[];
  draftsById: Map<string, Draft>;
  projectId: number;
  siteUrl: string | null;
  onChanged: () => void;
}) {
  const [moduleFilter, setModuleFilter] = useState<string | "all">("all");
  const [open, setOpen] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<DefectRecord | null>(null);
  const modules = useMemo(() => [...new Set(records.flatMap((r) => r.cases.map((c) => c.module)))].sort(), [records]);
  const shown = moduleFilter === "all" ? records : records.filter((r) => r.cases.some((c) => c.module === moduleFilter));
  const link = (path: string) => (siteUrl ? `${siteUrl}/${projectId}/${path}` : null);

  async function log(record: DefectRecord) {
    setWorking(record.id);
    try {
      const out = await logIncident(record.id, { typeId: null, priorityId: null, severityId: null });
      toast.success(`Logged as incident ${out.incident.incidentId}, linked to ${plural(out.incident.linked.length, "failed run")}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
      onChanged();
    }
  }

  async function confirmUndo(record: DefectRecord) {
    setUndoing(null);
    setWorking(record.id);
    try {
      const out = await undoDefect(record.id);
      if (out.errors.length) toast.warning(`Partly undone: ${out.errors[0]}${out.errors.length > 1 ? ` (and ${out.errors.length - 1} more)` : ""}`);
      else toast.success(`Undone: "${record.title}", its ${plural(record.cases.length, "run")} deleted from Spira and the cards moved back`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
      onChanged();
    }
  }

  if (records.length === 0) return null;
  return (
    <Section
      icon={Bug}
      title="Defects found"
      description="Every defect raised here, across modules. Open one to see its cases; undo deletes what this app recorded in Spira and moves the cards back."
      actions={
        modules.length > 1 && (
          <select className="input w-auto" aria-label="Filter by module" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}>
            <option value="all">All modules</option>
            {modules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )
      }
    >
      <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
        {shown.map((d) => {
          const url = d.incidentId ? link(`Incident/${d.incidentId}.aspx`) : null;
          const inModules = [...new Set(d.cases.map((c) => c.module))];
          const expanded = open === d.id;
          return (
            <li key={d.id} className="py-3">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <button type="button" className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : d.id)}>
                  <ChevronDown className={clsx("mt-0.5 size-4 shrink-0 text-slate-400 transition", expanded && "rotate-180")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{d.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-zinc-400">
                      {plural(d.cases.length, "case")} failed {formatDateTime(d.at)}
                      {d.tester ? ` by ${d.tester}` : ""}
                      {inModules.map((m) => <Badge key={m}>{m}</Badge>)}
                    </span>
                  </span>
                </button>
                {d.incidentId ? (
                  url ? (
                    <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
                      IN:{d.incidentId} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    <Badge tone="brand">IN:{d.incidentId}</Badge>
                  )
                ) : (
                  <Button size="sm" icon={Bug} busy={working === d.id} disabled={!!working} onClick={() => void log(d)} title="Logged with Spira's default type, priority and severity">
                    Log in Spira
                  </Button>
                )}
                <Button size="sm" variant="ghostDanger" icon={Undo2} disabled={!!working} onClick={() => setUndoing(d)}>
                  Undo
                </Button>
              </div>
              {expanded && (
                <div className="mt-2 ml-6 flex flex-col gap-2 text-xs">
                  <p className="whitespace-pre-wrap text-slate-600 dark:text-zinc-400">{d.description}</p>
                  <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-white/[0.06] dark:border-white/10">
                    {d.cases.map((c) => {
                      const runUrl = link(`TestRun/${c.testRunId}.aspx`);
                      const draft = draftsById.get(c.draftId);
                      return (
                        <li key={`${c.draftId}|${c.testRunId}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <span className="font-mono text-slate-500">TC{c.testCaseId}</span>
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          {c.stepLabel && <span className="text-slate-500">step {c.stepLabel}</span>}
                          {draft ? (
                            <Link href={`/drafts/${c.draftId}`} className="inline-flex items-center gap-1 font-medium hover:underline">
                              {c.module} <ArrowRight className="size-3" aria-hidden />
                            </Link>
                          ) : (
                            <span className="text-slate-400">{c.module} (draft deleted)</span>
                          )}
                          {c.from !== "defects" && <span className="text-slate-400">was {COLUMN_LABELS[c.from]}</span>}
                          {runUrl ? (
                            <a href={runUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300">
                              Run {c.testRunId} <ExternalLink className="size-3" aria-hidden />
                            </a>
                          ) : (
                            <span className="text-slate-500">Run {c.testRunId}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog
        open={undoing !== null}
        onClose={() => setUndoing(null)}
        title="Undo this defect?"
        footer={
          undoing && (
            <>
              <Button onClick={() => setUndoing(null)}>Cancel</Button>
              <Button variant="danger" icon={Undo2} onClick={() => void confirmUndo(undoing)}>
                Delete from Spira
              </Button>
            </>
          )
        }
      >
        {undoing && (
          <p>
            Deletes {undoing.incidentId ? `incident ${undoing.incidentId} and ` : ""}the {plural(undoing.cases.length, "Failed run")} recorded for &ldquo;{undoing.title}&rdquo;, then moves each card back to the column it came from (unless another defect still holds it). Each case then shows its previous result. Only what this app recorded is deleted.
          </p>
        )}
      </Dialog>
    </Section>
  );
}
