"use client";

import clsx from "clsx";
import { Bug, ExternalLink, Quote, RefreshCw, Search, Sparkles, Square, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, Dialog, Notice, ProgressBar, Section, Switch } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import {
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
import { formatDateTime } from "@/lib/client/format";
import { MAX_DEFECT_TEXT, pickBySeverity } from "@/lib/domain/defects";
import { currentStatus, STATUS_LABEL } from "@/lib/domain/execution";
import type { BlockedConfidence, Card, DefectRecord, Draft, IncidentOptions } from "@/lib/domain/types";
import { StatusChip } from "./runner";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const CONFIDENCE_TONE: Record<BlockedConfidence, "danger" | "warning" | "neutral"> = { high: "danger", medium: "warning", low: "neutral" };

const EXAMPLE = 'For example: On the Login screen, "Continue with phone number" stays enabled when the phone number field is empty, and tapping it opens the OTP screen.';

type Pick = { on: boolean; stepLabel: string | null };

function phaseText(phase: SearchPhase): string {
  if (phase.stage === "reading") return `Gemini is reading ${plural(phase.total, "case name")} for the defect…`;
  if (phase.stage === "steps") return `Reading the steps of ${plural(phase.total, "likely case")} from Spira (${phase.done} of ${phase.total})…`;
  return `Checking each case's steps against the defect (${phase.done} of ${phase.total})…`;
}

export function DefectFinder({
  draft,
  cards,
  scopeLabel,
  tester,
  disabled,
  onChange,
  onBusy,
}: {
  draft: Draft;
  /** In Scope cases the search covers. */
  cards: Card[];
  scopeLabel: string;
  tester: string;
  disabled: boolean;
  onChange: (draft: Draft) => void;
  onBusy: (keys: string[], on: boolean) => void;
}) {
  const { ai, spira } = useSettings();
  const aiOn = !!ai?.configured;
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
  const [working, setWorking] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<DefectRecord | null>(null);
  const stopRef = useRef(false);

  const searching = phase !== null;
  const siteUrl = spira?.siteUrl ?? null;
  const incidentUrl = (incidentId: number) => (siteUrl ? `${siteUrl}/${draft.projectId}/Incident/${incidentId}.aspx` : null);
  const defects = [...(draft.execution?.defects ?? [])].reverse();

  async function find() {
    const description = text.trim();
    if (description.length < 10 || !aiOn) return;
    setError(null);
    setOutcome(null);
    setShowUnaffected(false);
    setPhase({ stage: "reading", total: cards.length });
    try {
      const result = await searchDefect(draft, description, cards, setPhase);
      setSearch(result);
      setPicks(Object.fromEntries(result.cases.map((c) => [c.card.key, { on: c.match.verdict === "fails", stepLabel: c.match.stepLabel }])));
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
      const o = await readIncidentOptions(draft.projectId);
      setOptions(o);
      const type = o.types.find((t) => /bug|defect/i.test(t.name)) ?? o.types.find((t) => t.id === o.defaultTypeId) ?? null;
      setFields({ typeId: type?.id ?? null, priorityId: pickBySeverity(o.priorities, severity)?.id ?? null, severityId: pickBySeverity(o.severities, severity)?.id ?? null });
    } catch (err) {
      setOptionsError(errorMessage(err));
    }
  }

  const chosen = search ? search.cases.filter((c) => picks[c.card.key]?.on) : [];
  const needsStep = chosen.filter((c) => c.steps.length > 0 && !picks[c.card.key]?.stepLabel);
  const changedSince = search !== null && text.trim() !== search.description;
  const canRaise = chosen.length > 0 && needsStep.length === 0 && !changedSince && title.trim().length >= 3 && !disabled && !job;

  const setPick = (key: string, change: Partial<Pick>) => setPicks((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { on: false, stepLabel: null }), ...change } }));

  async function raise() {
    if (!search) return;
    setConfirming(false);
    stopRef.current = false;
    const keys = chosen.map((c) => c.card.key);
    setJob({ done: 0, total: chosen.length, stopping: false });
    onBusy(keys, true);
    try {
      const out = await raiseDefect(
        draft.id,
        {
          picks: chosen.map((c) => ({ card: c.card, steps: c.steps, stepLabel: picks[c.card.key]?.stepLabel ?? null })),
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
      onChange(out.draft);
      setOutcome(out);
      if (out.record) {
        const done = new Set(out.record.cases.map((c) => `${c.testSetId}:${c.testSetTestCaseId}`));
        setPicks((prev) => Object.fromEntries(Object.entries(prev).map(([k, p]) => [k, done.has(k) ? { ...p, on: false } : p])));
        if (out.failed.length === 0) {
          setSearch(null);
          setText("");
        }
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      onBusy(keys, false);
      setJob(null);
    }
  }

  async function retryIncident(defectId: string) {
    setWorking(defectId);
    try {
      const out = await logIncident(draft.id, defectId, fields);
      onChange(out.draft);
      setOutcome((o) => (o?.record?.id === defectId ? { ...o, record: out.record, incident: out.incident, incidentError: null } : o));
      toast.success(`Logged as incident ${out.incident.incidentId}, linked to ${plural(out.incident.linked.length, "failed run")}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
    }
  }

  async function confirmUndo(record: DefectRecord) {
    setUndoing(null);
    setWorking(record.id);
    try {
      const out = await undoDefect(draft.id, record.id);
      onChange(out.draft);
      if (outcome?.record?.id === record.id) setOutcome(null);
      if (out.errors.length) toast.warning(`Partly undone: ${out.errors[0]}${out.errors.length > 1 ? ` (and ${out.errors.length - 1} more)` : ""}`);
      else toast.success(`Undone: "${record.title}" and its ${plural(record.cases.length, "run")} deleted from Spira`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setWorking(null);
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
      title="Defect finder"
      description="Describe a defect in your own words. Gemini finds the In Scope cases it breaks and checks each one against its steps; you choose which to fail, and the defect is logged in Spira, linked to every failed run."
      actions={ai && <Badge tone={aiOn ? "brand" : "neutral"}>{aiOn ? <><Sparkles aria-hidden /> {ai.model}</> : "Gemini not configured"}</Badge>}
    >
      <div className="flex flex-col gap-4">
        {!aiOn && ai && (
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
              Name the screen, the action and what happened. Searches {plural(cards.length, "case")} in {scopeLabel}. <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> searches.
            </p>
            <Button variant="primary" icon={Search} busy={searching} disabled={!aiOn || text.trim().length < 10 || cards.length === 0 || !!job} onClick={() => void find()}>
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

        {outcome && !job && <OutcomeNotice outcome={outcome} incidentUrl={incidentUrl} working={working} onRetry={(id) => void retryIncident(id)} onDismiss={() => setOutcome(null)} />}

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
                Read {plural(search.searched, "case name")}, checked the steps of {plural(search.cases.length, "likely case")}. Suggested severity: {search.analysis.severity}.
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
              <p className="py-4 text-center text-sm text-slate-500">No case in {scopeLabel} looks affected by this defect. Add the screen or action and search again.</p>
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
                        <CaseRow key={c.card.key} item={c} draft={draft} pick={picks[c.card.key] ?? { on: false, stepLabel: null }} onPick={(change) => setPick(c.card.key, change)} disabled={!!job} />
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
                      <li key={c.card.key}>
                        <span className="font-mono">TC{c.card.testCaseId}</span> {c.card.name}: {c.match.reason}
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
                <Switch checked={logInSpira} onChange={setLogInSpira} label="Log the defect in Spira" description="One incident, linked to the failed step of every run, with steps to reproduce." />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-600 dark:text-zinc-400">
                    {needsStep.length > 0
                      ? `Choose the failing step for ${plural(needsStep.length, "ticked case")}.`
                      : chosen.length
                        ? `Your description becomes the actual result on each failing step${tester ? `, tested by ${tester}` : ""}.`
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

        {defects.length > 0 && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Defects logged here</h3>
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {defects.map((d) => {
                const url = d.incidentId ? incidentUrl(d.incidentId) : null;
                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{d.title}</p>
                      <p className="text-xs text-slate-500 dark:text-zinc-400">
                        {plural(d.cases.length, "case")} failed {formatDateTime(d.at)}
                        {d.tester ? ` by ${d.tester}` : ""}
                        {d.incidentId ? ` · incident linked to ${plural(d.linkedSteps, "run")}` : ""}
                      </p>
                    </div>
                    {d.incidentId ? (
                      url ? (
                        <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
                          IN:{d.incidentId} <ExternalLink className="size-3" aria-hidden />
                        </a>
                      ) : (
                        <Badge tone="brand">IN:{d.incidentId}</Badge>
                      )
                    ) : (
                      <Button size="sm" icon={Bug} busy={working === d.id} disabled={!!working || !!job} onClick={() => void retryIncident(d.id)}>
                        Log in Spira
                      </Button>
                    )}
                    <Button size="sm" variant="ghostDanger" icon={Undo2} disabled={!!working || !!job} onClick={() => setUndoing(d)}>
                      Undo
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
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
            This writes to Spira: {plural(chosen.length, "Failed test run")}
            {logInSpira ? " and one incident linked to them" : ""}. Each can be undone from Defects logged here.
          </p>
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs whitespace-pre-wrap dark:bg-white/[0.04]">{search?.description}</p>
          <ul className="max-h-48 overflow-y-auto text-xs">
            {chosen.map((c) => {
              const status = currentStatus(c.card, draft.execution);
              const label = picks[c.card.key]?.stepLabel;
              return (
                <li key={c.card.key} className="py-0.5">
                  <span className="font-mono">TC{c.card.testCaseId}</span> {clip(c.card.name, 70)}
                  {label ? `, fails at step ${label}` : ", whole case"}
                  {status === "passed" && <span className="text-amber-700 dark:text-amber-300"> (Passed now)</span>}
                </li>
              );
            })}
          </ul>
        </div>
      </Dialog>

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
            Deletes {undoing.incidentId ? `incident ${undoing.incidentId} and ` : ""}the {plural(undoing.cases.length, "Failed run")} recorded for &ldquo;{undoing.title}&rdquo;. Each case then shows its previous result. Only what this app recorded is deleted.
          </p>
        )}
      </Dialog>
    </Section>
  );
}

function CaseRow({ item, draft, pick, onPick, disabled }: { item: DefectCase; draft: Draft; pick: Pick; onPick: (change: Partial<Pick>) => void; disabled: boolean }) {
  const { card, steps, match } = item;
  const status = currentStatus(card, draft.execution);
  const step = steps.find((s) => s.label === pick.stepLabel);
  const setName = draft.testSets.length > 1 ? draft.testSets.find((s) => s.testSetId === card.testSetId)?.testSetName : null;
  return (
    <li className="flex gap-3 py-3">
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-red-600" aria-label={`Fail TC${card.testCaseId}`} checked={pick.on} disabled={disabled} onChange={(e) => onPick({ on: e.target.checked })} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-500">TC{card.testCaseId}</span>
          <span className="text-sm font-medium">{card.name}</span>
          <Badge tone={CONFIDENCE_TONE[match.confidence]}>{match.confidence} confidence</Badge>
          <StatusChip status={status} />
          {setName && <span className="text-xs text-slate-500">{setName}</span>}
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
        {pick.on && status === "passed" && <p className="text-xs text-amber-700 dark:text-amber-300">Passed in Spira now; this records a newer Failed run.</p>}
        {pick.on && status === "failed" && <p className="text-xs text-slate-500">Already Failed in Spira; a new run is added and linked to this defect.</p>}
        {pick.on && status && status !== "passed" && status !== "failed" && <p className="text-xs text-slate-500">{STATUS_LABEL[status]} in Spira now; this records a newer Failed run.</p>}
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
  working,
  onRetry,
  onDismiss,
}: {
  outcome: RaiseOutcome;
  incidentUrl: (id: number) => string | null;
  working: string | null;
  onRetry: (defectId: string) => void;
  onDismiss: () => void;
}) {
  const recorded = outcome.record?.cases.length ?? 0;
  const problems = outcome.failed.length > 0 || outcome.incidentError !== null || (outcome.incident?.unlinked.length ?? 0) > 0;
  const url = outcome.incident ? incidentUrl(outcome.incident.incidentId) : null;
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
        {outcome.incident?.unlinked.map((u) => <li key={u.testRunId}>{u.message}</li>)}
        {outcome.incidentError && outcome.record && (
          <li className="flex flex-wrap items-center gap-2">
            The defect was not logged: {outcome.incidentError}
            <Button size="sm" icon={RefreshCw} busy={working === outcome.record.id} onClick={() => onRetry(outcome.record!.id)}>
              Log it again
            </Button>
          </li>
        )}
        {outcome.failed.length > 0 && (
          <li>
            {plural(outcome.failed.length, "case")} not failed; they stay ticked so you can try again:
            <ul className="mt-1 list-disc pl-5 text-xs">
              {outcome.failed.slice(0, 6).map((f) => (
                <li key={f.card.key}>
                  TC{f.card.testCaseId}: {f.message}
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
