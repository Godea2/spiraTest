"use client";

import { FileChartColumn, FileSpreadsheet, NotebookPen, Printer, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/components/settings-context";
import { Button, ButtonLink, Collapsible, EmptyState, Field, Notice, PageHeader, ProgressBar, Section, Spinner, Switch } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { exportReportWorkbook, loadCatalog, loadReportOptions, readReportData, recordSnapshot, saveReportOptions, type ReportProgress } from "@/lib/client/report";
import {
  buildReport,
  compareSnapshots,
  folderFamily,
  folderPath,
  initialReportOptions,
  previousSnapshot,
  sameScope,
  scopeHints,
  setsInScope,
  snapshotOf,
  type DefectNote,
  type RagStatus,
  type ReportInput,
  type ReportOptions,
  type ReportScope,
  type ScopeHint,
} from "@/lib/domain/report";
import type { ReportCatalog } from "@/lib/domain/types";
import { ReportDocument, type ReportChanges } from "./report-document";

type CatalogState = { projectId: number; catalog: ReportCatalog | null; error: string | null };

function HintRow({ text, hints, empty, onPick }: { text: string; hints: ScopeHint[]; empty: string; onPick: (scope: ReportScope) => void }) {
  if (hints.length === 0) return <p>{empty}</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span>{text}</span>
      {hints.map((h) =>
        h.scope.releaseId === null ? (
          <span key="none" className="text-xs">
            {h.label} ({h.sets})
          </span>
        ) : (
          <Button key={`${h.scope.releaseId}:${h.scope.folderId}`} size="sm" variant="ghost" onClick={() => onPick(h.scope)}>
            {h.label} ({h.sets})
          </Button>
        ),
      )}
    </div>
  );
}

function ScopePicker({
  title,
  hint,
  catalog,
  scope,
  optional,
  onChange,
}: {
  title: string;
  hint: ReactNode;
  catalog: ReportCatalog;
  scope: ReportScope;
  optional?: boolean;
  onChange: (scope: ReportScope) => void;
}) {
  const sets = setsInScope(catalog, scope);
  const cases = sets.reduce((t, s) => t + Object.values(s.counts).reduce((a, b) => a + b, 0), 0);
  const folders = useMemo(
    () => catalog.folders.map((f) => ({ id: f.folderId, path: folderPath(catalog.folders, f.folderId) })).sort((a, b) => a.path.join("/").localeCompare(b.path.join("/"))),
    [catalog.folders],
  );
  // How many test sets each option would give with the other choice kept, so empty combinations show before generating.
  const counts = useMemo(() => {
    const count = (s: ReportScope) => {
      if (s.releaseId !== null) return setsInScope(catalog, s).length;
      if (s.folderId === null) return catalog.testSets.length;
      const family = folderFamily(catalog.folders, s.folderId);
      return catalog.testSets.filter((t) => t.folderId !== null && family.has(t.folderId)).length;
    };
    return {
      release: new Map(catalog.releases.map((r) => [r.releaseId, count({ releaseId: r.releaseId, folderId: scope.folderId })])),
      folder: new Map([null, ...catalog.folders.map((f) => f.folderId)].map((id) => [id, count({ releaseId: scope.releaseId, folderId: id })])),
    };
  }, [catalog, scope.releaseId, scope.folderId]);
  const hints = scope.releaseId !== null && sets.length === 0 ? scopeHints(catalog, scope) : null;
  const sized = (n: number | undefined) => ` · ${(n ?? 0).toLocaleString()} set${n === 1 ? "" : "s"}`;
  return (
    <div className="well flex flex-col gap-3 p-4">
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{hint}</p>
      </div>
      <Field label="Release">
        {(props) => (
          <select
            {...props}
            className="input"
            value={scope.releaseId ?? ""}
            onChange={(e) => onChange({ ...scope, releaseId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">{optional ? "No baseline" : "Choose a release"}</option>
            {catalog.releases.map((r) => (
              <option key={r.releaseId} value={r.releaseId}>
                {"\u00a0\u00a0".repeat(r.depth)}
                {r.label}
                {r.active ? "" : " (inactive)"}
                {sized(counts.release.get(r.releaseId))}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Test set folder" hint="Limits the scope to a cycle, for example SIT Cycle 2, including its subfolders.">
        {(props) => (
          <select
            {...props}
            className="input"
            value={scope.folderId ?? ""}
            onChange={(e) => onChange({ ...scope, folderId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">All folders{sized(counts.folder.get(null))}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {"\u00a0\u00a0".repeat(f.path.length - 1)}
                {f.path[f.path.length - 1]}
                {sized(counts.folder.get(f.id))}
              </option>
            ))}
          </select>
        )}
      </Field>
      {scope.releaseId !== null && sets.length > 0 && (
        <p className="text-xs text-slate-600 tabular-nums dark:text-zinc-400">
          {sets.length.toLocaleString()} test set{sets.length === 1 ? "" : "s"} · {cases.toLocaleString()} test case slots in Spira
        </p>
      )}
      {hints && (
        <Notice tone="warning" title="No test sets match this release and folder">
          <div className="flex flex-col gap-2">
            {scope.folderId !== null && (
              <HintRow
                text="The test sets in this folder are planned for:"
                hints={hints.byRelease}
                empty="This folder has no test sets."
                onPick={onChange}
              />
            )}
            <HintRow text="This release's test sets are in:" hints={hints.byFolder} empty="No test set in Spira is planned for this release or its sprints." onPick={onChange} />
          </div>
        </Notice>
      )}
    </div>
  );
}

export function ReportWorkspace() {
  const { settings, spira } = useSettings();
  const projectId = settings?.projectId ?? null;
  const configured = spira?.configured === true;

  const [catalogState, setCatalogState] = useState<CatalogState | null>(null);
  const [stored, setStored] = useState<{ projectId: number; options: ReportOptions | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<{ input: ReportInput; changes: ReportChanges | null } | null>(null);
  const [progress, setProgress] = useState<ReportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!configured || projectId === null) return;
    let cancelled = false;
    loadCatalog(projectId).then(
      (catalog) => {
        if (cancelled) return;
        setCatalogState({ projectId, catalog, error: null });
        setStored((current) => (current?.projectId === projectId ? current : { projectId, options: loadReportOptions(projectId) }));
      },
      (err) => !cancelled && setCatalogState({ projectId, catalog: null, error: errorMessage(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [configured, projectId, reload]);

  useEffect(() => () => abort.current?.abort(), []);

  const current = catalogState && catalogState.projectId === projectId ? catalogState : null;
  const catalog = current?.catalog ?? null;
  const settingsRelease = settings?.releaseId ?? null;
  const options = useMemo(() => {
    if (!catalog || stored?.projectId !== projectId) return null;
    return stored.options ?? initialReportOptions(catalog.releases, settingsRelease);
  }, [catalog, stored, projectId, settingsRelease]);

  const update = (patch: Partial<ReportOptions>) => {
    if (!options || projectId === null) return;
    const next = { ...options, ...patch };
    setStored({ projectId, options: next });
    try {
      saveReportOptions(projectId, next);
    } catch {
      // storage full: the choice lasts for this page only
    }
  };

  // Presentation choices apply at once; the scope applies to the data read for it.
  const report = useMemo(() => {
    if (!data || !options || data.input.catalog.projectId !== projectId) return null;
    return buildReport({ ...data.input, options: { ...options, baseline: data.input.options.baseline, scoped: data.input.options.scoped } });
  }, [data, options, projectId]);
  const scopeChanged = !!(data && options && (!sameScope(data.input.options.scoped, options.scoped) || !sameScope(data.input.options.baseline, options.baseline)));

  const generate = async () => {
    if (!options || projectId === null || !catalog || setsInScope(catalog, options.scoped).length === 0) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setProgress({ step: "Reading releases and test sets", done: 0, total: 1 });
    try {
      const fresh = await loadCatalog(projectId, controller.signal);
      setCatalogState({ projectId, catalog: fresh, error: null });
      const input = await readReportData({ catalog: fresh, options, mappings: settings?.mappings ?? [], onProgress: setProgress, signal: controller.signal });
      const built = buildReport(input);
      const before = recordSnapshot(built, options);
      const previous = previousSnapshot(before, built);
      setData({ input, changes: previous ? { since: previous.at, rows: compareSnapshots(previous, snapshotOf(built)) } : null });
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err));
    } finally {
      if (abort.current === controller) setProgress(null);
    }
  };

  const busy = progress !== null;
  const scopedSets = catalog && options ? setsInScope(catalog, options.scoped).length : 0;
  const actions = report && (
    <>
      <Button icon={Printer} onClick={() => window.print()}>
        Print or save PDF
      </Button>
      <Button icon={FileSpreadsheet} onClick={() => void exportReportWorkbook(report, spira?.siteUrl ?? null)}>
        Excel
      </Button>
    </>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <PageHeader
          eyebrow={
            <>
              <FileChartColumn className="size-4" aria-hidden /> Reports
            </>
          }
          title="Executive test report"
          description="Read live from Spira every time: progress, readiness against exit criteria, defects and retesting, and the scope compared with the baseline release. Nothing is written to Spira."
          actions={actions}
        />
      </div>

      {spira && !configured && (
        <Notice tone="warning" title="Spira is not connected" className="print:hidden" action={<ButtonLink href="/settings" icon={Settings2} size="sm">Settings</ButtonLink>}>
          The report reads everything from Spira. Connect it in Settings first.
        </Notice>
      )}
      {configured && settings && projectId === null && (
        <Notice tone="warning" title="Choose a project" className="print:hidden" action={<ButtonLink href="/settings" icon={Settings2} size="sm">Settings</ButtonLink>}>
          Pick the Spira project in Settings, then come back here.
        </Notice>
      )}
      {current?.error && (
        <Notice tone="danger" title="Could not read the project from Spira" className="print:hidden" action={<Button size="sm" icon={RefreshCw} onClick={() => setReload((n) => n + 1)}>Try again</Button>}>
          {current.error}
        </Notice>
      )}
      {configured && projectId !== null && !current && (
        <div className="surface flex items-center gap-3 p-6 text-sm text-slate-600 print:hidden dark:text-zinc-400">
          <Spinner /> Reading releases, folders and test sets from Spira…
        </div>
      )}

      {catalog && options && (
        <Section
          className="print:hidden"
          title="Report setup"
          description={`${catalog.projectName}: ${catalog.releases.length} releases, ${catalog.testSets.length} test sets. Your choices are kept in this browser.`}
          actions={
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => setReload((n) => n + 1)} disabled={busy}>
              Refresh lists
            </Button>
          }
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ScopePicker
              title="In scope"
              hint="The release being executed, for example 1.0.0.0002. Progress, readiness and defects are measured here."
              catalog={catalog}
              scope={options.scoped}
              onChange={(scoped) => update({ scoped })}
            />
            <ScopePicker
              title="Baseline"
              hint="The full set of test cases across modules and platforms, for example 1.0.0.0001. The scope is compared with it."
              catalog={catalog}
              scope={options.baseline}
              optional
              onChange={(baseline) => update({ baseline })}
            />
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Report title" hint="Empty uses the project name.">
              {(props) => <input {...props} className="input" value={options.title} placeholder={`${catalog.projectName} — Test Report`} onChange={(e) => update({ title: e.target.value })} />}
            </Field>
            <Field label="Cycle" hint="Shown in the header.">
              {(props) => <input {...props} className="input" value={options.environment} placeholder="SIT Cycle 2" onChange={(e) => update({ environment: e.target.value })} />}
            </Field>
            <Field label="Prepared by">
              {(props) => <input {...props} className="input" value={options.preparedBy} onChange={(e) => update({ preparedBy: e.target.value })} />}
            </Field>
            <Field label="Go-live date">
              {(props) => <input {...props} type="date" className="input" value={options.goLive ?? ""} onChange={(e) => update({ goLive: e.target.value || null })} />}
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Exit target: executed (%)">
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={1}
                  max={100}
                  className="input"
                  value={options.targets.executedPct}
                  onChange={(e) => update({ targets: { ...options.targets, executedPct: Math.min(100, Math.max(1, Number(e.target.value) || 100)) } })}
                />
              )}
            </Field>
            <Field label="Exit target: pass rate (%)">
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={1}
                  max={100}
                  className="input"
                  value={options.targets.passRatePct}
                  onChange={(e) => update({ targets: { ...options.targets, passRatePct: Math.min(100, Math.max(1, Number(e.target.value) || 95)) } })}
                />
              )}
            </Field>
            <Field label="Defect ageing SLA (days)">
              {(props) => (
                <input
                  {...props}
                  type="number"
                  min={1}
                  max={365}
                  className="input"
                  value={options.targets.agingDays}
                  onChange={(e) => update({ targets: { ...options.targets, agingDays: Math.min(365, Math.max(1, Number(e.target.value) || 10)) } })}
                />
              )}
            </Field>
            <Field label="Overall status" hint={report ? `From the exit criteria: ${report.autoStatus.toUpperCase()}` : "From the exit criteria unless you set it."}>
              {(props) => (
                <select {...props} className="input" value={options.status} onChange={(e) => update({ status: e.target.value as "auto" | RagStatus })}>
                  <option value="auto">From the exit criteria</option>
                  <option value="green">Green</option>
                  <option value="amber">Amber</option>
                  <option value="red">Red</option>
                </select>
              )}
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Build name" hint={`Shown as "This build (Phase 1)" and in the defect register.`}>
              {(props) => <input {...props} className="input" value={options.phase} placeholder="Phase 1" onChange={(e) => update({ phase: e.target.value })} />}
            </Field>
            <Field label="Baseline name" hint="Used in the cycle comparison. Empty uses the baseline folder.">
              {(props) => <input {...props} className="input" value={options.baselineName} placeholder="Cycle 1" onChange={(e) => update({ baselineName: e.target.value })} />}
            </Field>
            <Field label="Executions" hint={report?.window.first ? `Empty reads the run dates: ${report.window.first.slice(0, 10)} to ${report.window.last?.slice(0, 10)}.` : "Empty reads the run dates from Spira."}>
              {(props) => <input {...props} className="input" value={options.windowText} placeholder="Fri 9 – Sun 11 Oct 2026" onChange={(e) => update({ windowText: e.target.value })} />}
            </Field>
            <div className="pt-6">
              <Switch checked={options.appendix} onChange={(appendix) => update({ appendix })} label="Add appendix" description="Data checks, trend, test sets and failed cases after the four pages." />
            </div>
          </div>

          <Field label="QA notes" hint="Optional. Shown on the first page, for example scope decisions or build notes." className="mt-4">
            {(props) => <textarea {...props} rows={3} className="input" value={options.notes} onChange={(e) => update({ notes: e.target.value })} />}
          </Field>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={FileChartColumn} onClick={() => void generate()} busy={busy} disabled={scopedSets === 0}>
              {data ? "Read Spira again" : "Generate report"}
            </Button>
            {options.scoped.releaseId === null ? (
              <span className="text-sm text-slate-500">Choose the release in scope first.</span>
            ) : (
              scopedSets === 0 && <span className="text-sm text-slate-500">No test sets are in scope; pick a release and folder that hold test sets.</span>
            )}
            {busy && progress && (
              <div className="flex min-w-60 flex-1 flex-col gap-1.5">
                <span className="text-xs text-slate-600 tabular-nums dark:text-zinc-400">
                  {progress.step}
                  {progress.total > 1 && ` · ${progress.done} of ${progress.total}`}
                </span>
                <ProgressBar value={progress.done} max={Math.max(1, progress.total)} />
              </div>
            )}
          </div>
          {scopeChanged && !busy && (
            <Notice tone="info" className="mt-4">
              The scope changed since Spira was read. Read Spira again to report on the new scope; the report below is still for the previous one.
            </Notice>
          )}
        </Section>
      )}

      {error && (
        <Notice tone="danger" title="The report could not be read from Spira" className="print:hidden">
          {error}
        </Notice>
      )}

      {report && report.defects.rows.length > 0 && options && (
        <div className="print:hidden">
          <Collapsible title="Defect register notes" count={report.defects.rows.length} icon={NotebookPen} open={notesOpen} onToggle={() => setNotesOpen((o) => !o)}>
            <p className="px-5 pt-2 text-sm text-slate-600 dark:text-zinc-400">
              Your reading of each defect for the register on page 4: the feature, whether it is in {report.labels.name}, and why it has its severity and priority. Kept in this
              browser; Spira is not changed.
            </p>
            <div className="overflow-x-auto px-5 pt-3 pb-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 dark:text-zinc-400">
                    <th className="py-1.5 pr-3 font-medium">Defect</th>
                    <th className="py-1.5 pr-3 font-medium">Feature</th>
                    <th className="py-1.5 pr-3 font-medium">Scope</th>
                    <th className="py-1.5 font-medium">Rationale</th>
                  </tr>
                </thead>
                <tbody>
                  {report.defects.rows.map((r) => {
                    const id = String(r.incident.incidentId);
                    const note: DefectNote = options.defectNotes[id] ?? { feature: "", phase: "", rationale: "" };
                    const setNote = (patch: Partial<DefectNote>) => update({ defectNotes: { ...options.defectNotes, [id]: { ...note, ...patch } } });
                    return (
                      <tr key={id} className="border-t border-slate-100 align-top dark:border-white/[0.06]">
                        <td className="py-2 pr-3">
                          <span className="font-medium">IN:{id}</span> {r.incident.name}
                          <span className="block text-xs text-slate-500 dark:text-zinc-400">
                            {r.severity} severity · {r.priority} priority{r.modules.length ? ` · ${r.modules.join(", ")}` : ""}
                          </span>
                        </td>
                        <td className="w-48 py-2 pr-3">
                          <input className="input" aria-label={`Feature of IN:${id}`} value={note.feature} placeholder={r.modules.join(", ") || "Feature"} onChange={(e) => setNote({ feature: e.target.value })} />
                        </td>
                        <td className="w-44 py-2 pr-3">
                          <select className="input" aria-label={`Scope of IN:${id}`} value={note.phase} onChange={(e) => setNote({ phase: e.target.value as DefectNote["phase"] })}>
                            <option value="">{r.testCaseIds.length ? `${report.labels.inBuild} (linked case)` : "Not stated"}</option>
                            <option value="in">{report.labels.inBuild}</option>
                            <option value="out">{report.labels.outside}</option>
                            <option value="tbc">To confirm</option>
                          </select>
                        </td>
                        <td className="min-w-64 py-2">
                          <input className="input" aria-label={`Rationale for IN:${id}`} value={note.rationale} placeholder="Why this severity and priority" onChange={(e) => setNote({ rationale: e.target.value })} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Collapsible>
        </div>
      )}

      {report ? (
        <ReportDocument report={report} changes={data?.changes ?? null} siteUrl={spira?.siteUrl ?? null} />
      ) : (
        catalog &&
        options &&
        !busy && (
          <div className="print:hidden">
            <EmptyState icon={FileChartColumn} title="No report yet">
              Choose the release in scope and the baseline, then generate. Every figure is read from Spira at that moment.
            </EmptyState>
          </div>
        )
      )}
    </div>
  );
}
