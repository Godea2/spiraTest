"use client";

import clsx from "clsx";
import { ArrowRight, Bug, ChevronDown, ExternalLink, Layers, Plus, Quote, RefreshCw, Search, Sparkles, Square, Undo2, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Notice, PageHeader, ProgressBar, Section, Spinner, Switch } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import {
  adoptDraftDefects,
  createDefectTestCase,
  listDefects,
  logIncident,
  newCaseTargets,
  raiseDefect,
  readAutoNewCase,
  readIncidentOptions,
  readLeftOutModules,
  readNewCaseStatus,
  searchDefect,
  storeAutoNewCase,
  storeLeftOutModules,
  storeNewCaseStatus,
  suggestNewCase,
  undoDefect,
  type DefectCase,
  type DefectPick,
  type DefectSearch,
  type IncidentFields,
  type NewCaseTarget,
  type RaiseOutcome,
  type SearchPhase,
} from "@/lib/client/defects";
import { allDrafts } from "@/lib/client/drafts";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import { formatDateTime } from "@/lib/client/format";
import { effectiveColumn, isCompleted } from "@/lib/domain/board";
import { defectTargets, MAX_DEFECT_TEXT, MAX_NEW_CASE_SETS, MAX_NEW_CASE_STEPS, pickBySeverity } from "@/lib/domain/defects";
import { currentStatus, STATUS_LABEL } from "@/lib/domain/execution";
import {
  COLUMN_LABELS,
  type BlockedConfidence,
  type Column,
  type CreatedDefectCase,
  type DefectRecord,
  type Draft,
  type IncidentOptions,
  type NewDefectCase,
} from "@/lib/domain/types";
import { COLUMN_STYLE } from "../drafts/[id]/board-parts";
import { StatusChip } from "../drafts/[id]/execute/runner";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CONFIDENCE_TONE: Record<BlockedConfidence, "danger" | "warning" | "neutral"> = { high: "danger", medium: "warning", low: "neutral" };

const EXAMPLE = 'For example: On the Login screen, "Continue with phone number" stays enabled when the phone number field is empty, and tapping it opens the OTP screen.';

type Pick = { on: boolean; stepLabel: string | null };

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="shrink-0 text-slate-400 tabular-nums">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

function phaseText(phase: SearchPhase): string {
  if (phase.stage === "understanding") return `Gemini is working out which feature the defect is in (${plural(phase.modules, "module")} to search)…`;
  if (phase.stage === "reading") return `Gemini is matching ${plural(phase.total, "case")} in ${plural(phase.modules, "module")} to ${phase.feature ? `"${phase.feature}"` : "the defect"}…`;
  return `Checking the steps of ${plural(phase.total, "likely case")} against the defect: ${phase.read} read from Spira, ${phase.done} checked. Results show below as they come in…`;
}

/** The new test case being written for a defect no existing case covers. */
type NewCaseForm = {
  status: "drafting" | "ready" | "error";
  error: string | null;
  reason: string;
  testCase: NewDefectCase;
  /** Chosen test sets, by NewCaseTarget key. */
  targets: string[];
};

const EMPTY_CASE: NewDefectCase = { name: "", description: "", steps: [{ description: "", expectedResult: "" }], failingStep: 1 };

/** Why the new test case cannot be created yet, or null. */
function newCaseProblem(form: NewCaseForm): string | null {
  if (form.status !== "ready") return form.status === "drafting" ? "Gemini is drafting the test case." : "Write the test case first.";
  if (form.targets.length === 0) return "Choose the test set it goes in.";
  if (form.testCase.name.trim().length < 5) return "Give the test case a name.";
  if (form.testCase.steps.some((s) => s.description.trim().length < 3)) return "Every step needs an action.";
  return null;
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
          // A module opened from its board is always searched.
          setExcluded(new Set(readLeftOutModules().filter((id) => id !== from)));
        },
        (err) => active && setLoadError(errorMessage(err)),
      );
    return () => {
      active = false;
    };
  }, [from]);

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
            description="Choose the modules the defect is likely in: fewer modules make a faster, sharper search. Your choice is remembered in this browser."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={scoped.length === inProject.length}
                  onClick={() => leaveOut(new Set([...excluded].filter((id) => !inProject.some((d) => d.id === id))))}
                >
                  All
                </Button>
                <Button size="sm" variant="ghost" disabled={scoped.length === 0} onClick={() => leaveOut(new Set([...excluded, ...inProject.map((d) => d.id)]))}>
                  None
                </Button>
                {projects.length > 1 && (
                  <select className="input w-auto" aria-label="Spira project" value={projectId ?? ""} onChange={(e) => setProject(Number(e.target.value))}>
                    {projects.map((p) => <option key={p} value={p}>Project {p}</option>)}
                  </select>
                )}
              </div>
            }
          >
            <div className="flex flex-col gap-4">
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                {scoped.length === 0
                  ? "No module chosen. Tick the modules to search."
                  : `Searching ${plural(scoped.length, "module")} of ${inProject.length}, ${plural(scopedCases, "case")}.`}
              </p>
              <div className="flex flex-wrap gap-2">
                {inProject.map((d) => {
                  const on = !excluded.has(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        const next = new Set(excluded);
                        if (on) next.add(d.id);
                        else next.delete(d.id);
                        leaveOut(next);
                      }}
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
              allModules={inProject.length}
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
  allModules,
  draftsById,
  tester,
  aiOn,
  aiKnown,
  siteUrl,
  onChanged,
}: {
  projectId: number;
  drafts: Draft[];
  allModules: number;
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
  const [timing, setTiming] = useState<{ startedAt: number; tookMs: number | null } | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState<IncidentOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [fields, setFields] = useState<IncidentFields>({ typeId: null, priorityId: null, severityId: null });
  const [passBefore, setPassBefore] = useState(true);
  const [logInSpira, setLogInSpira] = useState(true);
  const [showUnaffected, setShowUnaffected] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<{ done: number; total: number; stopping: boolean; creating?: boolean } | null>(null);
  const [outcome, setOutcome] = useState<RaiseOutcome | null>(null);
  const [outcomeNotes, setOutcomeNotes] = useState<string[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [newCase, setNewCase] = useState<NewCaseForm | null>(null);
  const [autoNewCase, setAutoNewCase] = useState(readAutoNewCase);
  const stopRef = useRef(false);
  /** Changes with each search and each edit of the new case: the confirmation opens on its own only for the case as drafted. */
  const searchRun = useRef(0);
  const optionsLoad = useRef<Promise<void> | null>(null);
  const { settings } = useSettings();
  const caseTargets = useMemo(() => newCaseTargets(drafts), [drafts]);

  const searching = phase !== null;
  const incidentUrl = (incidentId: number) => (siteUrl ? `${siteUrl}/${projectId}/Incident/${incidentId}.aspx` : null);
  const idOf = (c: DefectCase) => `${c.target.draftId}|${c.target.card.key}`;

  async function find() {
    const description = text.trim();
    if (description.length < 10 || !aiOn || drafts.length === 0) return;
    const run = ++searchRun.current;
    setError(null);
    setOutcome(null);
    setShowUnaffected(false);
    setNewCase(null);
    setSearch(null);
    setPicks({});
    setPhase({ stage: "understanding", modules: drafts.length });
    const startedAt = Date.now();
    setTiming({ startedAt, tookMs: null });
    let result: DefectSearch | null = null;
    let shown = false;
    // Verdicts arrive batch by batch; a case's verdict is final once shown, and ticks made meanwhile are kept.
    const show = (s: DefectSearch) => {
      setSearch(s);
      setPicks((prev) => {
        const next = { ...prev };
        for (const c of s.cases) next[idOf(c)] ??= { on: c.match.verdict === "fails", stepLabel: c.match.stepLabel };
        return next;
      });
      if (!shown) {
        shown = true;
        setTitle(s.analysis.title);
        optionsLoad.current = loadOptions(s.analysis.severity);
      }
    };
    try {
      result = await searchDefect(drafts, description, setPhase, show);
      setTiming({ startedAt, tookMs: Date.now() - startedAt });
      show(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase(null);
    }
    // No existing case fails ("might be affected" ones are unconfirmed), or Gemini could not finish: the defect
    // gets a test case of its own to be failed against. With the option on, its confirmation opens as soon as
    // it is drafted, but only after a complete search, so a case Gemini could not check is not overlooked.
    if (result && !result.cases.some((c) => c.match.verdict === "fails")) void draftNewCase(result, autoNewCase && result.complete ? run : null);
  }

  async function draftNewCase(from: DefectSearch, confirmFor: number | null = null) {
    const statusId = readNewCaseStatus(projectId);
    setNewCase({ status: "drafting", error: null, reason: "", testCase: { ...EMPTY_CASE, statusId }, targets: [] });
    try {
      const s = await suggestNewCase(drafts, from);
      const form: NewCaseForm = {
        status: "ready",
        error: null,
        reason: s.reason,
        testCase: { name: s.name, description: s.description, steps: s.steps, failingStep: s.failingStep, statusId },
        targets: s.testSetKeys.filter((k) => caseTargets.some((t) => t.key === k)),
      };
      setNewCase(form);
      if (confirmFor !== null && form.targets.length > 0 && !newCaseProblem(form)) {
        // Spira's lists first, so the incident fields and the case's status are settled before confirming.
        await optionsLoad.current;
        if (searchRun.current === confirmFor) {
          // A failed new case is always reported: the confirmation is the final approval for all of it.
          setLogInSpira(true);
          setConfirming(true);
        }
      }
    } catch (err) {
      setNewCase({ status: "error", error: errorMessage(err), reason: "", testCase: { ...EMPTY_CASE, statusId }, targets: [] });
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
  const newTargets = newCase ? caseTargets.filter((t) => newCase.targets.includes(t.key)) : [];
  const newBlocker = newCase ? newCaseProblem(newCase) : null;
  const total = chosen.length + (newCase ? newTargets.length : 0);
  const canRaise = total > 0 && needsStep.length === 0 && !newBlocker && !changedSince && title.trim().length >= 3 && !job && !searching;
  const chosenModules = [...new Set([...chosen.map((c) => c.target.module), ...newTargets.map((t) => t.module)])];
  const moving = chosen.filter((c) => columnOf(c) !== "defects");
  const recheck = [...new Set(moving.filter((c) => !draftsById.get(c.target.draftId) || !isCompleted(draftsById.get(c.target.draftId)!.status)).map((c) => c.target.module))];

  const setPick = (id: string, change: Partial<Pick>) => setPicks((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { on: false, stepLabel: null }), ...change } }));

  async function raise() {
    if (!search) return;
    setConfirming(false);
    stopRef.current = false;
    setOutcomeNotes([]);
    setJob({ done: 0, total, stopping: false });
    let extra: DefectPick[] = [];
    let created: CreatedDefectCase | null = null;
    const notes: string[] = [];
    if (newCase && newTargets.length > 0) {
      setJob((j) => j && { ...j, creating: true });
      try {
        // Only a status from the project's own list is sent; anything else falls back to the project's default.
        const statusId = options?.testCaseStatuses.some((s) => s.id === newCase.testCase.statusId) ? newCase.testCase.statusId : null;
        const made = await createDefectTestCase({ targets: newTargets, testCase: { ...newCase.testCase, statusId } }, settings?.mappings ?? []);
        extra = made.picks;
        created = made.created;
        notes.push(`New test case TC${made.created.testCaseId} "${made.created.name}" added to ${newTargets.map((t) => t.testSetName).join(", ")}, in the Defects column.`, ...made.problems);
        setNewCase(null);
      } catch (err) {
        toast.error(`The test case was not created: ${errorMessage(err)}`);
        setJob(null);
        onChanged();
        return;
      }
    }
    try {
      const out = await raiseDefect(
        {
          picks: [...chosen.map((c) => ({ target: c.target, steps: c.steps, stepLabel: picks[idOf(c)]?.stepLabel ?? null })), ...extra],
          description: search.description,
          title,
          expected: search.analysis.expected,
          passBefore,
          logIncident: logInSpira,
          fields,
          created,
        },
        tester,
        { onProgress: (done, all) => setJob((j) => (j ? { ...j, done, total: all, creating: false } : j)), keepGoing: () => !stopRef.current },
      );
      setOutcome(out);
      setOutcomeNotes(notes);
      if (out.record) {
        const done = new Set(out.record.cases.map((c) => `${c.draftId}|${c.testSetId}:${c.testSetTestCaseId}`));
        setPicks((prev) => Object.fromEntries(Object.entries(prev).map(([k, p]) => [k, done.has(k) ? { ...p, on: false } : p])));
        if (out.failed.length === 0) {
          setSearch(null);
          setText("");
        }
      }
    } catch (err) {
      toast.error(created ? `TC${created.testCaseId} was created, but failing the cases stopped: ${errorMessage(err)}` : errorMessage(err));
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
      description="Gemini works out which feature the defect is in, picks the cases about that feature by context (whatever they call it), then checks each one against its steps in Spira, naming the failing step and quoting the case. You choose which to fail."
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
          <Switch
            checked={autoNewCase}
            onChange={(on) => {
              setAutoNewCase(on);
              storeAutoNewCase(on);
            }}
            label="When no case fails, add the defect as a new test case"
            description="Gemini drafts the test case, and the confirmation to create it in Spira, add it to its test sets and fail it opens on its own. Nothing is written until you confirm; cases that only might be affected are left for you to check."
          />
        </div>

        {phase && (
          <div className="flex flex-col gap-1.5 rounded-xl bg-slate-50 px-4 py-3 text-sm dark:bg-white/[0.03]">
            <span className="flex items-baseline justify-between gap-3">
              <span>{phaseText(phase)}</span>
              {timing && <Elapsed since={timing.startedAt} />}
            </span>
            <ProgressBar
              value={phase.stage === "understanding" ? 1 : phase.stage === "reading" ? 2 : phase.read + phase.done}
              max={phase.stage === "understanding" || phase.stage === "reading" ? 3 : Math.max(1, phase.total * 2)}
            />
          </div>
        )}
        {error && <Notice tone="danger" title="The search did not finish">{error}</Notice>}

        {outcome && !job && (
          <OutcomeNotice outcome={outcome} notes={outcomeNotes} incidentUrl={incidentUrl} retrying={retrying} onRetry={(id) => void retryIncident(id)} onDismiss={() => setOutcome(null)} />
        )}

        {search && (
          <div className="flex flex-col gap-4">
            {search.understood && (
              <div className="rounded-xl border border-slate-200 px-4 py-3 text-sm dark:border-white/10">
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-zinc-400">Gemini reads this as</p>
                <p className="mt-1">
                  <span className="font-medium">{search.analysis.feature || search.analysis.area || "Unknown feature"}</span>
                  {search.analysis.symptom && <> · {search.analysis.symptom}</>}
                </p>
                {search.analysis.expected && <p className="mt-0.5 text-slate-600 dark:text-zinc-400">Expected: {search.analysis.expected}</p>}
                {search.analysis.related.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500 dark:text-zinc-400">
                    <span>Also matched as</span>
                    {search.analysis.related.map((r) => <Badge key={r}>{r}</Badge>)}
                  </p>
                )}
                <p className="mt-1.5 text-xs text-slate-500 dark:text-zinc-400">
                  Matched {search.searched === search.total ? plural(search.total, "case") : `${search.searched} of ${plural(search.total, "case")}`} in{" "}
                  {plural(search.modules, "module")} to this feature by context and checked the steps of {plural(search.cases.length, "likely case")}
                  {timing?.tookMs != null ? ` in ${Math.max(1, Math.round(timing.tookMs / 1000))}s` : ""}. Suggested severity: {search.analysis.severity}.
                </p>
              </div>
            )}
            {search.unreadError &&
              (search.searched === 0 ? (
                <Notice tone="warning" title="Gemini could not finish the search" action={<Button size="sm" icon={RefreshCw} disabled={searching || !!job} onClick={() => void find()}>Search again</Button>}>
                  {search.unreadError} The existing cases were not matched, so search again in a moment, or add the defect as a new test case below and fail it.
                </Notice>
              ) : (
                <Notice tone="warning" title={`${plural(search.total - search.searched, "case name")} could not be read`} action={<Button size="sm" icon={RefreshCw} disabled={searching || !!job} onClick={() => void find()}>Search again</Button>}>
                  Gemini did not answer for part of the cases ({search.unreadError}), so a case there may be missing. Search again to read every case.
                </Notice>
              ))}
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
              searching || search.searched === 0 ? null : (
                <p className="py-2 text-center text-sm text-slate-500">
                  No case in the {plural(search.modules, "module")} searched is about this feature, including Out of Scope cases on drafts.
                  {drafts.length < allModules ? " Include more modules above and search again, or add" : " Add"} it as a new test case below, so it can be failed and reported.
                </p>
              )
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

            {newCase ? (
              <NewCasePanel
                form={newCase}
                targets={caseTargets}
                statuses={options?.testCaseStatuses ?? (optionsError ? [] : undefined)}
                onStatusChosen={(statusId) => storeNewCaseStatus(projectId, statusId)}
                disabled={!!job}
                onChange={(change) => {
                  searchRun.current += 1;
                  setNewCase((f) => (f ? { ...f, ...change } : f));
                }}
                onRetry={() => void draftNewCase(search)}
                onRemove={() => {
                  searchRun.current += 1;
                  setNewCase(null);
                }}
              />
            ) : searching ? null : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm dark:border-white/15">
                <span className="text-slate-600 dark:text-zinc-400">None of these covers the defect? Add it as a new test case and fail it.</span>
                <Button size="sm" icon={Plus} disabled={!!job} onClick={() => void draftNewCase(search)}>Add a new test case</Button>
              </div>
            )}

            {(search.cases.length > unaffected.length || newCase) && (
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
                      : newBlocker
                        ? `New test case: ${newBlocker}`
                        : total
                          ? `${plural(total, "case")} in ${chosenModules.join(", ")}${newTargets.length ? ", including the new test case" : ""}. Your description becomes the actual result on each failing step${tester ? `, tested by ${tester}` : ""}.`
                          : "Tick the cases to fail."}
                  </p>
                  <Button variant="danger" icon={Bug} disabled={!canRaise} onClick={() => setConfirming(true)}>
                    {newTargets.length && !chosen.length ? "Create & fail the new case" : `Fail ${plural(total, "case")}`}
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
            title={
              job.creating
                ? "Creating the test case in Spira and adding it to its test sets…"
                : `Failing cases in Spira: ${job.done} of ${job.total}${job.stopping ? " (stopping after this batch)" : ""}`
            }
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
        title={
          newTargets.length > 0 && chosen.length === 0
            ? `Create the test case, fail it${logInSpira ? " and log the defect" : ""}?`
            : `Fail ${plural(total, "case")} for this defect?`
        }
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" icon={Bug} disabled={!canRaise} onClick={() => void raise()}>
              {newTargets.length ? "Create & fail" : "Fail"} {total}
              {logInSpira ? " & log defect" : ""}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            This writes to Spira: {newTargets.length > 0 && <>a new test case, added to {plural(newTargets.length, "test set")}; </>}
            {plural(total, "Failed test run")} in {plural(chosenModules.length, "module")}
            {logInSpira ? ", and one incident linked to them" : ""}. It can be undone from the defect list below{newTargets.length > 0 ? ", which also deletes the new test case" : ""}.
          </p>
          {newCase && newTargets.length > 0 && (
            <div className="rounded-lg border border-violet-200 px-3 py-2 text-sm dark:border-violet-400/20">
              <p className="font-medium">New: {newCase.testCase.name}</p>
              <ol className="mt-1 list-decimal pl-5 text-xs text-slate-600 dark:text-zinc-400">
                <li>Created in Spira with its {plural(newCase.testCase.steps.length, "step")} and added to {newTargets.map((t) => `${t.testSetName} (${t.module})`).join(", ")}.</li>
                <li>Placed in the Defects column of its board, so it counts as In Scope.</li>
                <li>Failed in Spira at step {newCase.testCase.failingStep}, with your description as the actual result.</li>
                {logInSpira ? <li>Logged as an incident, linked to that failed step.</li> : <li>No incident: &quot;Log the defect in Spira&quot; is off.</li>}
              </ol>
            </div>
          )}
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

function NewCasePanel({
  form,
  targets,
  statuses,
  disabled,
  onChange,
  onStatusChosen,
  onRetry,
  onRemove,
}: {
  form: NewCaseForm;
  targets: NewCaseTarget[];
  /** The project's test case statuses; undefined while loading. */
  statuses: IncidentOptions["testCaseStatuses"] | undefined;
  disabled: boolean;
  onChange: (change: Partial<NewCaseForm>) => void;
  onStatusChosen: (statusId: number | null) => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { testCase } = form;
  const setCase = (change: Partial<NewDefectCase>) => onChange({ testCase: { ...testCase, ...change } });
  const onStatus = (statusId: number | null) => {
    setCase({ statusId });
    onStatusChosen(statusId);
  };
  const setStep = (index: number, change: Partial<NewDefectCase["steps"][number]>) =>
    setCase({ steps: testCase.steps.map((s, i) => (i === index ? { ...s, ...change } : s)) });
  const removeStep = (index: number) =>
    setCase({
      steps: testCase.steps.filter((_, i) => i !== index),
      failingStep: Math.max(1, testCase.failingStep > index + 1 ? testCase.failingStep - 1 : Math.min(testCase.failingStep, testCase.steps.length - 1)),
    });
  const toggleTarget = (key: string, on: boolean) => {
    const platform = targets.find((t) => t.key === key)?.platform;
    // One test set per platform: ticking another for the same platform replaces it.
    const others = form.targets.filter((k) => k !== key && (!on || targets.find((t) => t.key === k)?.platform !== platform));
    onChange({ targets: on ? [...others, key].slice(-MAX_NEW_CASE_SETS) : others });
  };
  const modules = [...new Set(targets.map((t) => t.module))];

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-400/20 dark:bg-violet-500/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4 text-violet-600 dark:text-violet-300" aria-hidden /> Add the defect as a new test case
          </h3>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-zinc-400">
            No existing case covers it, so it gets one: created in Spira, added to the test set, placed in Defects (In Scope) on the board, and failed at the
            step below. Undo deletes it again.
          </p>
        </div>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>Don&apos;t add</Button>
      </div>

      {form.status === "drafting" && (
        <p className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-400"><Spinner className="size-4" /> Gemini is writing the test case and choosing its test set…</p>
      )}
      {form.status === "error" && (
        <Notice
          tone="warning"
          title="Gemini could not draft it"
          action={
            <span className="flex gap-2">
              <Button size="sm" icon={RefreshCw} onClick={onRetry}>Try again</Button>
              <Button size="sm" onClick={() => onChange({ status: "ready", error: null })}>Write it myself</Button>
            </span>
          }
        >
          {form.error}
        </Notice>
      )}

      {form.status === "ready" && (
        <>
          <fieldset className="flex flex-col gap-2" disabled={disabled}>
            <legend className="text-sm font-medium">Test set</legend>
            {form.reason && <p className="text-xs text-slate-600 dark:text-zinc-400">{form.reason}</p>}
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {modules.map((name) => (
                <div key={name} className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-slate-500 dark:text-zinc-400">{name}</span>
                  {targets
                    .filter((t) => t.module === name)
                    .map((t) => (
                      <label key={t.key} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="size-4 accent-violet-600" checked={form.targets.includes(t.key)} onChange={(e) => toggleTarget(t.key, e.target.checked)} />
                        <span className="min-w-0 truncate">{t.testSetName}</span>
                        <Badge>{t.platform}</Badge>
                      </label>
                    ))}
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-500 dark:text-zinc-400">Each ticked test set gets the case and a Failed run. Tick only the platforms where the defect was seen.</p>
          </fieldset>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Name</span>
            <input className="input" value={testCase.name} maxLength={255} disabled={disabled} onChange={(e) => setCase({ name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Description</span>
            <textarea className="input min-h-16" value={testCase.description} maxLength={4_000} disabled={disabled} onChange={(e) => setCase({ description: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:max-w-xs">
            <span className="font-medium">Status in Spira</span>
            <select
              className="input"
              value={statuses?.some((s) => s.id === testCase.statusId) ? String(testCase.statusId) : ""}
              disabled={disabled || !statuses}
              onChange={(e) => onStatus(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{statuses ? "Project default" : "Loading…"}</option>
              {statuses?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span className="text-xs text-slate-500 dark:text-zinc-400">The test case&apos;s own status. Its run is recorded as Failed either way.</span>
          </label>

          <fieldset className="flex flex-col gap-2" disabled={disabled}>
            <legend className="text-sm font-medium">Steps</legend>
            <ol className="flex flex-col gap-2">
              {testCase.steps.map((step, i) => (
                <li key={i} className={clsx("flex flex-col gap-2 rounded-lg border p-2.5 sm:flex-row", testCase.failingStep === i + 1 ? "border-red-300 dark:border-red-400/40" : "border-slate-200 dark:border-white/10")}>
                  <span className="w-6 shrink-0 pt-2 text-xs font-semibold text-slate-500">{i + 1}</span>
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                    <textarea className="input min-h-14 text-sm" aria-label={`Step ${i + 1} action`} placeholder="Action" value={step.description} maxLength={2_000} onChange={(e) => setStep(i, { description: e.target.value })} />
                    <textarea className="input min-h-14 text-sm" aria-label={`Step ${i + 1} expected result`} placeholder="Expected result" value={step.expectedResult} maxLength={2_000} onChange={(e) => setStep(i, { expectedResult: e.target.value })} />
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="radio" name="failing-step" className="accent-red-600" checked={testCase.failingStep === i + 1} onChange={() => setCase({ failingStep: i + 1 })} />
                      Fails here
                    </label>
                    {testCase.steps.length > 1 && (
                      <Button size="sm" variant="ghost" onClick={() => removeStep(i)}>Remove</Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {testCase.steps.length < MAX_NEW_CASE_STEPS && (
              <Button size="sm" variant="ghost" icon={Plus} className="self-start" onClick={() => setCase({ steps: [...testCase.steps, { description: "", expectedResult: "" }] })}>
                Add a step
              </Button>
            )}
          </fieldset>
        </>
      )}
    </div>
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
  notes,
  incidentUrl,
  retrying,
  onRetry,
  onDismiss,
}: {
  outcome: RaiseOutcome;
  notes: string[];
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
        {notes.map((n) => <li key={n}>{n}</li>)}
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
  const { settings } = useSettings();
  const modulesOf = (r: DefectRecord) => [...new Set([...r.cases.map((c) => c.module), ...(r.created?.memberships.map((m) => m.module) ?? [])])];
  const modules = useMemo(() => [...new Set(records.flatMap(modulesOf))].sort(), [records]);
  const shown = moduleFilter === "all" ? records : records.filter((r) => modulesOf(r).includes(moduleFilter));
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
      const out = await undoDefect(record.id, settings?.mappings ?? []);
      if (out.errors.length) toast.warning(`Partly undone: ${out.errors[0]}${out.errors.length > 1 ? ` (and ${out.errors.length - 1} more)` : ""}`);
      else
        toast.success(
          `Undone: "${record.title}", its ${plural(record.cases.length, "run")}${record.created ? ` and test case TC${record.created.testCaseId}` : ""} deleted from Spira and the cards moved back`,
        );
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
          const inModules = modulesOf(d);
          const caseUrl = d.created ? link(`TestCase/${d.created.testCaseId}.aspx`) : null;
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
                      {d.created && <Badge tone="brand">New TC{d.created.testCaseId}</Badge>}
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
                ) : d.cases.length > 0 ? (
                  <Button size="sm" icon={Bug} busy={working === d.id} disabled={!!working} onClick={() => void log(d)} title="Logged with Spira's default type, priority and severity">
                    Log in Spira
                  </Button>
                ) : null}
                <Button size="sm" variant="ghostDanger" icon={Undo2} disabled={!!working} onClick={() => setUndoing(d)}>
                  Undo
                </Button>
              </div>
              {expanded && (
                <div className="mt-2 ml-6 flex flex-col gap-2 text-xs">
                  <p className="whitespace-pre-wrap text-slate-600 dark:text-zinc-400">{d.description}</p>
                  {d.created && (
                    <p className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="brand">Created for this defect</Badge>
                      {caseUrl ? (
                        <a href={caseUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300">
                          TC{d.created.testCaseId} {d.created.name} <ExternalLink className="size-3" aria-hidden />
                        </a>
                      ) : (
                        <span>TC{d.created.testCaseId} {d.created.name}</span>
                      )}
                      <span className="text-slate-500">in {d.created.memberships.map((m) => m.module).join(", ")}</span>
                    </p>
                  )}
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
            Deletes {undoing.incidentId ? `incident ${undoing.incidentId} and ` : ""}the {plural(undoing.cases.length, "Failed run")} recorded for &ldquo;{undoing.title}&rdquo;, then moves each card back to the column it came from (unless another defect still holds it). Each case then shows its previous result.
            {undoing.created && <> Test case TC{undoing.created.testCaseId}, created for this defect, is deleted too and its boards are recompared.</>} Only what this app recorded is deleted.
          </p>
        )}
      </Dialog>
    </Section>
  );
}
