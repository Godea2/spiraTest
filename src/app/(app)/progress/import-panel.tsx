"use client";

import { Check, FileSpreadsheet, Square, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Dialog, Notice, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import {
  mapProgressSheet,
  parseProgressSheet,
  picksFromImport,
  recordProgress,
  type ImportSheet,
  type MappedImportRow,
  type PassProgressOutcome,
} from "@/lib/client/progress";
import { STATUS_LABEL } from "@/lib/domain/execution";
import type { Draft, ExecutionStatus } from "@/lib/domain/types";
import { StatusChip } from "../drafts/[id]/execute/runner";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const RESULTS: ExecutionStatus[] = ["passed", "failed", "blocked", "caution"];

/**
 * Upload a colleague's progress / issue spreadsheet: columns are detected (Module, Feature, Issue,
 * Status, Retest Result, …), Gemini maps each actionable row to In Scope cases, and you confirm the
 * Pass / Fail / Blocked runs before Spira is updated.
 */
export function ImportPanel({
  drafts,
  tester,
  aiOn,
  onChanged,
}: {
  drafts: Draft[];
  tester: string;
  aiOn: boolean;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<ImportSheet | null>(null);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [mapped, setMapped] = useState<MappedImportRow[] | null>(null);
  const [mapping, setMapping] = useState<{ done: number; total: number; label: string } | null>(null);
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<{ done: number; total: number; stopping: boolean } | null>(null);
  const [outcome, setOutcome] = useState<PassProgressOutcome | null>(null);
  const stopRef = useRef(false);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setParseError(null);
    setMapped(null);
    setOutcome(null);
    setSheet(null);
    try {
      const parsed = await parseProgressSheet(file);
      setSheet(parsed);
      setFileName(file.name);
    } catch (err) {
      setParseError(errorMessage(err));
    }
  }

  async function match() {
    if (!sheet || !aiOn || drafts.length === 0) return;
    setMapping({ done: 0, total: sheet.actionable, label: "" });
    setMapped(null);
    setOutcome(null);
    try {
      const rows = await mapProgressSheet(sheet, drafts, setMapping);
      setMapped(rows);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setMapping(null);
    }
  }

  const picks = mapped ? picksFromImport(mapped) : [];
  const actionableRows = mapped?.filter((m) => m.result && m.selected.size > 0) ?? [];

  function setResult(rowNumber: number, result: ExecutionStatus | null) {
    setMapped((list) => list?.map((m) => (m.row.rowNumber === rowNumber ? { ...m, result, reason: result ? `Record as ${STATUS_LABEL[result]} (edited).` : m.reason } : m)) ?? null);
  }

  function toggleCase(rowNumber: number, key: string) {
    setMapped(
      (list) =>
        list?.map((m) => {
          if (m.row.rowNumber !== rowNumber) return m;
          const selected = new Set(m.selected);
          if (selected.has(key)) selected.delete(key);
          else selected.add(key);
          return { ...m, selected };
        }) ?? null,
    );
  }

  async function apply() {
    setConfirming(false);
    stopRef.current = false;
    setJob({ done: 0, total: picks.length, stopping: false });
    try {
      const out = await recordProgress(picks, tester, {
        force,
        onProgress: (done, total) => setJob((j) => (j ? { ...j, done, total } : j)),
        keepGoing: () => !stopRef.current,
      });
      setOutcome(out);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setJob(null);
      onChanged();
    }
  }

  return (
    <Section
      icon={FileSpreadsheet}
      title="Upload a progress sheet"
      description="Drop a colleague's Excel or CSV issue / retest log. Columns are detected automatically (Module, Feature, Issue Observed, Status, Retest Result, Platform). Gemini maps each row that has a clear Pass, Fail or Deferred outcome to In Scope cases; you confirm before Spira is updated."
    >
      <div className="flex flex-col gap-4">
        {!aiOn && (
          <Notice tone="warning" title="Gemini is not configured on the server">
            Matching rows to test cases needs GEMINI_API_KEY. You can still upload a sheet to see how its columns were read.
          </Notice>
        )}

        <div
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm transition hover:border-brand-400 hover:bg-brand-50/40 dark:border-white/15 dark:hover:bg-brand-500/10"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFile(e.dataTransfer.files[0]);
          }}
          onClick={() => input.current?.click()}
        >
          <Upload className="size-6 text-slate-400" aria-hidden />
          <span className="font-medium">Drop a .xlsx or .csv here, or click to choose</span>
          <span className="text-xs text-slate-500">First sheet is used. Headers can be Module, Feature / Area, Issue Observed, Status, Retest Result, …</span>
          <input
            ref={input}
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>

        {parseError && <Notice tone="danger" title="The sheet could not be read">{parseError}</Notice>}

        {sheet && (
          <div className="flex flex-col gap-3 rounded-xl bg-slate-50 px-4 py-3 dark:bg-white/[0.03]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{fileName}</p>
                <p className="text-xs text-slate-500">
                  Sheet &quot;{sheet.sheetName}&quot; · {plural(sheet.rows.length, "row")} · {sheet.actionable} with a Pass / Fail / Blocked outcome · {sheet.skipped} skipped for now
                </p>
                <p className="mt-1 text-xs text-slate-600 dark:text-zinc-400">
                  Columns used:{" "}
                  {Object.entries(sheet.map.fields)
                    .map(([field, header]) => `${header} → ${field}`)
                    .join(" · ")}
                </p>
              </div>
              <Button variant="primary" icon={FileSpreadsheet} busy={!!mapping} disabled={!aiOn || drafts.length === 0 || !!job} onClick={() => void match()}>
                Match to test cases
              </Button>
            </div>
          </div>
        )}

        {mapping && (
          <Notice tone="info" title={`Matching rows: ${mapping.done} of ${mapping.total}`}>
            <ProgressBar value={mapping.done} max={Math.max(1, mapping.total)} />
            {mapping.label && <p className="mt-1.5 text-xs truncate">{mapping.label}</p>}
            <p className="mt-1 text-xs">Nothing is written to Spira until you confirm below.</p>
          </Notice>
        )}

        {outcome && !job && (
          <Notice
            tone={outcome.failed.length && outcome.recorded === 0 ? "danger" : outcome.failed.length ? "warning" : "success"}
            title={outcome.recorded === 0 ? "No run was recorded" : `${plural(outcome.recorded, "run")} recorded in Spira`}
            action={
              <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>
                Dismiss
              </Button>
            }
          >
            {outcome.recorded > 0 && <p>Open Reports and generate again for the latest figures. New Failed runs can be raised as incidents from Execute or Defects.</p>}
            {outcome.failed.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs">
                {outcome.failed.slice(0, 8).map((f) => (
                  <li key={`${f.target.draftId}|${f.target.card.key}`}>
                    TC{f.target.card.testCaseId}: {f.message}
                  </li>
                ))}
                {outcome.failed.length > 8 && <li>and {outcome.failed.length - 8} more</li>}
              </ul>
            )}
          </Notice>
        )}

        {mapped && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-600 dark:text-zinc-400">
              Review each row: change the result if needed, untick cases that do not belong. Only ticked cases on rows with a result are written to Spira.
            </p>
            <ul className="flex flex-col gap-3">
              {mapped.map((m) => {
                const keyOf = (c: (typeof m.matches)[0]) => `${c.target.draftId}|${c.target.card.key}`;
                return (
                  <li key={m.row.rowNumber} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {m.row.sn ? `#${m.row.sn} · ` : ""}
                          {m.row.module || "No module"}
                          {m.row.feature ? ` · ${clip(m.row.feature, 80)}` : ""}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-600 dark:text-zinc-400">{clip(m.row.issue || m.row.testerComment || "(no issue text)", 280)}</p>
                        <p className="mt-1 text-xs text-slate-500">{m.reason}</p>
                        {m.error && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">{m.error}</p>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {m.row.status && <Badge>{m.row.status}</Badge>}
                        {m.row.retest && <Badge tone="brand">{clip(m.row.retest, 40)}</Badge>}
                        <select
                          className="input h-8 w-auto text-xs"
                          aria-label={`Result for row ${m.row.sn || m.row.rowNumber}`}
                          value={m.result ?? ""}
                          disabled={!!job}
                          onChange={(e) => setResult(m.row.rowNumber, (e.target.value || null) as ExecutionStatus | null)}
                        >
                          <option value="">Skip</option>
                          {RESULTS.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {m.result && m.matches.length === 0 && !mapping && (
                      <p className="mt-2 text-xs text-slate-500">No related In Scope cases found in the chosen modules. Try including more modules above, or describe this row under Describe instead.</p>
                    )}
                    {m.matches.length > 0 && (
                      <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-white/[0.06] dark:border-white/10">
                        {m.matches.map((c) => {
                          const key = keyOf(c);
                          return (
                            <li key={key} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                              <input
                                type="checkbox"
                                className="size-4 accent-brand-600"
                                checked={m.selected.has(key)}
                                disabled={!!job || !m.result}
                                onChange={() => toggleCase(m.row.rowNumber, key)}
                              />
                              <span className="font-mono text-slate-500">TC{c.target.card.testCaseId}</span>
                              <span className="min-w-0 flex-1 truncate">{c.target.card.name}</span>
                              <Badge tone={c.candidate.relevance === "high" ? "brand" : c.candidate.relevance === "medium" ? "warning" : "neutral"}>{c.candidate.relevance}</Badge>
                              <span className="text-slate-500">{c.target.module}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="flex flex-col gap-3 rounded-xl bg-slate-50 p-4 dark:bg-white/[0.03]">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={force} disabled={!!job} onChange={(e) => setForce(e.target.checked)} />
                <span>
                  <span className="font-medium">Force a new run when Spira already shows the same result</span>
                  <span className="block text-xs text-slate-500">Leave off unless you need a fresh run for the report.</span>
                </span>
              </label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-600 dark:text-zinc-400">
                  {picks.length === 0
                    ? "Tick cases on rows with a Pass, Fail or Blocked result."
                    : `${plural(picks.length, "run")} from ${plural(actionableRows.length, "sheet row")}${tester ? `, tested by ${tester}` : ""}.`}
                </p>
                <Button variant="primary" icon={Check} disabled={picks.length === 0 || !!job || !!mapping} onClick={() => setConfirming(true)}>
                  Record {picks.length || ""} in Spira
                </Button>
              </div>
            </div>
          </div>
        )}

        {job && (
          <Notice
            tone="info"
            title={`Recording: ${job.done} of ${job.total}${job.stopping ? " (stopping after this batch)" : ""}`}
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
          </Notice>
        )}

        {mapping && !mapped && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Matching sheet rows to test cases…
          </p>
        )}
      </div>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Record ${plural(picks.length, "run")} in Spira?`}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" icon={Check} onClick={() => void apply()}>
              Record {picks.length}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>Writes test runs from the sheet into Spira (Passed, Failed or Blocked as reviewed). Failed cases can then be raised as incidents from Execute or Defects.</p>
          <ul className="max-h-56 overflow-y-auto text-xs">
            {RESULTS.filter((s) => picks.some((p) => p.status === s)).map((s) => (
              <li key={s} className="flex items-center gap-2 py-0.5">
                <StatusChip status={s} />
                <span>{plural(picks.filter((p) => p.status === s).length, "case")}</span>
              </li>
            ))}
          </ul>
        </div>
      </Dialog>
    </Section>
  );
}
