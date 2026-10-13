"use client";

import { Bug, ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Button, Dialog, Notice, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { releaseFiles, type PendingFile } from "@/lib/client/attachments";
import {
  prepareRunIncident,
  raiseRunIncident,
  readEnvironment,
  readIncidentOptions,
  storeEnvironment,
  suggestRunIncident,
  type IncidentFields,
  type RunIncidentDraft,
} from "@/lib/client/defects";
import { MAX_ATTACHMENTS, MAX_ENVIRONMENT } from "@/lib/domain/defect-report";
import { MAX_DEFECT_TEXT, pickBySeverity } from "@/lib/domain/defects";
import type { Card, Draft, ExecutionRun, IncidentOptions } from "@/lib/domain/types";
import { AttachmentPicker } from "../../../defects/attachment-picker";
import { OptionSelect } from "../../../defects/option-select";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A title to start from when Gemini is not there: the case and the first line of what went wrong. */
function plainTitle(module: string, card: Card, actual: string): string {
  const first = actual.split("\n").find((l) => l.trim())?.trim() ?? "";
  return clip(first ? `${module}: ${first}` : card.name, 255);
}

/**
 * Raises a case failed here as a Spira incident, in one step: filled in from the failed run and its
 * test case (read only), with Gemini's title and severity when it is configured. Spira passes the
 * incident on to Jira when the project syncs incidents there.
 */
export function IncidentDialog({ draft, card, run, tester, onClose, onDone }: { draft: Draft; card: Card; run: ExecutionRun; tester: string; onClose: () => void; onDone: () => void }) {
  const { spira, ai } = useSettings();
  const [prepared, setPrepared] = useState<RunIncidentDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<IncidentOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [fields, setFields] = useState<IncidentFields>({ typeId: null, priorityId: null, severityId: null });
  const [title, setTitle] = useState("");
  const [actual, setActual] = useState("");
  const [expected, setExpected] = useState("");
  const [environment, setEnvironment] = useState(readEnvironment);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const edited = useRef({ title: false, severity: false });
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => () => releaseFiles(filesRef.current), []);

  useEffect(() => {
    let active = true;
    const optionsLoad = readIncidentOptions(draft.projectId).then(
      (o) => {
        if (!active) return o;
        setOptions(o);
        const type = o.types.find((t) => /bug|defect/i.test(t.name)) ?? o.types.find((t) => t.id === o.defaultTypeId) ?? null;
        setFields((f) => ({ ...f, typeId: type?.id ?? null }));
        return o;
      },
      (err) => {
        if (active) setOptionsError(errorMessage(err));
        return null;
      },
    );
    prepareRunIncident(draft.projectId, card, run.testRunId).then(
      async (p) => {
        if (!active) return;
        setPrepared(p);
        setActual(p.failure.actual || run.comment);
        setExpected(p.failure.expected);
        setTitle(plainTitle(draft.module, card, p.failure.actual || run.comment));
        if (!ai?.configured) return;
        setSuggesting(true);
        const [suggestion, o] = await Promise.all([suggestRunIncident(draft, card, p.failure, p.steps), optionsLoad]);
        if (!active) return;
        setSuggesting(false);
        if (!suggestion) return;
        if (!edited.current.title) setTitle(clip(suggestion.title, 255));
        if (o && !edited.current.severity) {
          setFields((f) => ({ ...f, severityId: pickBySeverity(o.severities, suggestion.severity)?.id ?? f.severityId, priorityId: pickBySeverity(o.priorities, suggestion.severity)?.id ?? f.priorityId }));
        }
      },
      (err) => active && setLoadError(errorMessage(err)),
    );
    return () => {
      active = false;
    };
    // Loaded once for the run the dialog was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = prepared?.steps.find((s) => s.label === prepared.failure.stepLabel) ?? null;
  const canRaise = !!prepared && title.trim().length >= 3 && actual.trim().length >= 10 && !working;
  const runUrl = spira?.siteUrl ? `${spira.siteUrl}/${draft.projectId}/TestRun/${run.testRunId}.aspx` : null;

  async function raise() {
    if (!prepared) return;
    setWorking(files.length ? "Uploading the files…" : "Logging the incident in Spira…");
    try {
      const out = await raiseRunIncident(
        {
          draftId: draft.id,
          card,
          testRunId: run.testRunId,
          title,
          description: actual,
          expected,
          environment,
          stepLabel: prepared.failure.stepLabel,
          reproduce: prepared.reproduce,
          fields,
          files,
        },
        tester,
        { onFiles: (done, total) => setWorking(done < total ? `Uploading file ${done + 1} of ${total}…` : "Logging the incident in Spira…") },
      );
      storeEnvironment(environment);
      const notAttached = out.files?.failed.length ?? 0;
      if (out.incident) {
        const url = spira?.siteUrl ? `${spira.siteUrl}/${draft.projectId}/Incident/${out.incident.incidentId}.aspx` : null;
        const message = `TC${card.testCaseId} raised as incident IN:${out.incident.incidentId}${notAttached ? `; ${notAttached} file(s) not attached, add them from Defects` : ""}`;
        (notAttached ? toast.warning : toast.success)(message, url ? { action: { label: "Open in Spira", onClick: () => window.open(url, "_blank", "noopener,noreferrer") } } : undefined);
        onDone();
      } else {
        toast.error(`The incident was not logged: ${out.incidentError ?? "unknown error"}. Try again from here or from Defects.`);
        onDone();
      }
    } catch (err) {
      toast.error(errorMessage(err));
      setWorking(null);
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={() => {
        if (!working) onClose();
      }}
      title={`Raise TC${card.testCaseId} as an incident`}
      footer={
        <>
          <Button disabled={!!working} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon={Bug} busy={!!working} disabled={!canRaise} onClick={() => void raise()}>
            {working ?? "Raise incident in Spira"}
          </Button>
        </>
      }
    >
      {loadError ? (
        <Notice tone="danger" title="The failed run could not be read">
          {loadError}
        </Notice>
      ) : !prepared ? (
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Reading the failed run and its steps from Spira…
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-white/[0.04]">
            <p className="font-medium">
              {card.name}
              {runUrl && (
                <a href={runUrl} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-1 font-normal text-brand-700 hover:underline dark:text-brand-300">
                  Run {run.testRunId} <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </p>
            <p className="mt-0.5 text-slate-600 dark:text-zinc-400">
              {step ? `Failed at step ${step.label}: ${clip(step.step.description, 160)}` : "No step is marked Failed in this run; the incident is linked to it once Spira shows a Failed step."}
            </p>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              Defect title
              {suggesting && (
                <span className="inline-flex items-center gap-1 text-xs font-normal text-slate-500">
                  <Sparkles className="size-3" aria-hidden /> Gemini is writing a title…
                </span>
              )}
            </span>
            <input
              className="input"
              value={title}
              maxLength={255}
              onChange={(e) => {
                edited.current.title = true;
                setTitle(e.target.value);
              }}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">What happened</span>
              <textarea className="input min-h-24" value={actual} maxLength={MAX_DEFECT_TEXT} placeholder="What the app did instead" onChange={(e) => setActual(e.target.value)} />
              {actual.trim().length < 10 && <span className="text-xs text-slate-500">At least 10 characters.</span>}
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Expected result</span>
              <textarea className="input min-h-24" value={expected} maxLength={MAX_DEFECT_TEXT} placeholder="What should happen" onChange={(e) => setExpected(e.target.value)} />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <OptionSelect label="Type" list={options?.types} value={fields.typeId} onChange={(typeId) => setFields((f) => ({ ...f, typeId }))} />
            <OptionSelect
              label="Severity"
              list={options?.severities}
              value={fields.severityId}
              onChange={(severityId) => {
                edited.current.severity = true;
                setFields((f) => ({ ...f, severityId }));
              }}
            />
            <OptionSelect
              label="Priority"
              list={options?.priorities}
              value={fields.priorityId}
              onChange={(priorityId) => {
                edited.current.severity = true;
                setFields((f) => ({ ...f, priorityId }));
              }}
            />
          </div>
          {optionsError && <p className="text-xs text-amber-700 dark:text-amber-300">Spira&apos;s incident lists could not be read ({optionsError}); the incident gets Spira&apos;s defaults.</p>}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              Environment <span className="font-normal text-slate-500">(optional, remembered on this browser)</span>
            </span>
            <input
              className="input"
              value={environment}
              maxLength={MAX_ENVIRONMENT}
              placeholder="Device, OS and app version, e.g. iPhone 14, iOS 17.5, app 1.0.2 (45)"
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </label>
          {prepared.reproduce.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">Steps to reproduce ({prepared.reproduce.length}, from the test case)</summary>
              <ol className="mt-1 flex flex-col gap-0.5 pl-1 text-xs text-slate-600 dark:text-zinc-400">
                {prepared.reproduce.map((s) => (
                  <li key={s.label}>
                    {s.label}. {s.step.description || "(no action text)"}
                    {s.step.sampleData.trim() && <span className="text-slate-500"> (data: {s.step.sampleData.trim()})</span>}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Screenshots and recordings</span>
            <AttachmentPicker files={files} onChange={setFiles} max={MAX_ATTACHMENTS} disabled={!!working} />
          </div>
          <p className="text-xs text-slate-600 dark:text-zinc-400">
            Creates one incident in Spira, linked to the Failed step of run {run.testRunId}, with these details, the steps to reproduce and the files (also attached to the run). If the
            project syncs incidents to Jira, Spira sends it there. The run itself is not changed; undo from Defects deletes only the incident and the files.
          </p>
        </div>
      )}
    </Dialog>
  );
}
