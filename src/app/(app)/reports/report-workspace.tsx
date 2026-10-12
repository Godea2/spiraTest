"use client";

import clsx from "clsx";
import { ChevronDown, Eye, FileChartColumn, GitCompareArrows, Layers, Link2, NotebookPen, RefreshCw, Settings2, Target, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Collapsible, EmptyState, Field, Notice, PageHeader, ProgressBar, Section, Spinner, Switch } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { exportReportWorkbook, loadCatalog, loadReportOptions, readReportData, recordSnapshot, saveReportOptions, type ReportProgress } from "@/lib/client/report";
import {
  buildReport,
  compareSnapshots,
  decodeShare,
  encodeShare,
  formatPct,
  initialReportOptions,
  previousSnapshot,
  resolveReportOptions,
  sameScope,
  scopeName,
  setsInScope,
  snapshotOf,
  splitText,
  type DefectNote,
  type RagStatus,
  type Report,
  type ReportInput,
  type ReportKind,
  type ReportOptions,
} from "@/lib/domain/report";
import type { ReportCatalog } from "@/lib/domain/types";
import { type ReportChanges } from "./report-document";
import { ReportViewer } from "./report-viewer";

type CatalogState = { projectId: number; catalog: ReportCatalog | null; error: string | null };

const STATUS_TONE: Record<RagStatus, "success" | "warning" | "danger"> = { green: "success", amber: "warning", red: "danger" };

const KINDS: { kind: ReportKind; icon: LucideIcon; title: (phase: string) => string; text: string }[] = [
  {
    kind: "build",
    icon: Target,
    title: (phase) => `${phase}: scoped test cases`,
    text: "Progress of the cases in scope for this build: executions, pass rate, modules ready for UAT and defects.",
  },
  {
    kind: "buildVsPlan",
    icon: GitCompareArrows,
    title: (phase) => `${phase}: scoped vs total test plan`,
    text: "The same build measured against the full test plan, with what is left for later builds and the change since the last cycle.",
  },
  {
    kind: "plan",
    icon: Layers,
    title: () => "Total test plan",
    text: "Every case in the full plan across all modules and platforms, with the results recorded against it.",
  },
];

function KindPicker({ value, phase, onChange }: { value: ReportKind; phase: string; onChange: (kind: ReportKind) => void }) {
  return (
    <div role="radiogroup" aria-label="Report type" className="grid gap-3 md:grid-cols-3">
      {KINDS.map(({ kind, icon: Icon, title, text }) => {
        const selected = value === kind;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(kind)}
            className={clsx(
              "well flex cursor-pointer flex-col gap-2 p-4 text-left transition",
              selected ? "ring-2 ring-brand-500 dark:ring-brand-400" : "hover:border-slate-300 dark:hover:border-white/20",
            )}
          >
            <span className="flex items-start gap-2">
              <Icon className={clsx("mt-0.5 size-4 shrink-0", selected ? "text-brand-600 dark:text-brand-400" : "text-slate-400")} aria-hidden />
              <span className="flex-1 text-sm font-semibold">{title(phase)}</span>
              {kind === "buildVsPlan" && <Badge tone="brand">Recommended</Badge>}
            </span>
            <span className="text-xs leading-relaxed text-slate-600 dark:text-zinc-400">{text}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReleaseSelect({ label, catalog, releaseId, onChange }: { label: string; catalog: ReportCatalog; releaseId: number | null; onChange: (releaseId: number | null) => void }) {
  const counts = useMemo(() => new Map(catalog.releases.map((r) => [r.releaseId, setsInScope(catalog, { releaseId: r.releaseId, folderId: null }).length])), [catalog]);
  const scope = { releaseId, folderId: null };
  const sets = setsInScope(catalog, scope);
  const slots = sets.reduce((t, s) => t + Object.values(s.counts).reduce((a, b) => a + b, 0), 0);
  const hint =
    releaseId === null
      ? "Choose a release."
      : sets.length
        ? `${scopeName(catalog, scope)} · ${sets.length.toLocaleString()} test set${sets.length === 1 ? "" : "s"} · ${slots.toLocaleString()} test case slots in Spira`
        : "No test sets in Spira are planned for this release.";
  return (
    <Field label={label} hint={hint}>
      {(props) => (
        <select {...props} className="input" value={releaseId ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose a release</option>
          {catalog.releases.map((r) => (
            <option key={r.releaseId} value={r.releaseId}>
              {"\u00a0\u00a0".repeat(r.depth)}
              {r.label}
              {r.active ? "" : " (inactive)"} · {counts.get(r.releaseId) ?? 0} sets
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-xl leading-none font-semibold tracking-tight tabular-nums">{value}</dd>
      {hint && <dd className="mt-1 text-xs text-slate-500 tabular-nums dark:text-zinc-500">{hint}</dd>}
    </div>
  );
}

/** The generated report in brief, with the button that opens it. */
function ReportSummary({ report, onOpen, onShare }: { report: Report; onOpen: () => void; onShare: () => void }) {
  const k = report.kpis;
  return (
    <section className="surface flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold tracking-tight">{report.title}</p>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-zinc-400">
            {report.labels.build}: every case in the test sets of {report.scopedName} ({report.scopedLabel})
            {report.hasBaseline ? `, measured against the total test plan in ${report.baselineName} (${report.baselineLabel}).` : "."}
          </p>
        </div>
        <Badge tone={STATUS_TONE[report.status]}>Overall {report.status.toUpperCase()}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {report.hasBaseline ? (
          <Figure label="Total test plan" value={k.plan.toLocaleString()} hint={splitText(k.split.plan, report.streams)} />
        ) : (
          <Figure label="Modules" value={report.modules.length.toLocaleString()} hint={`${report.readiness.ready} ready for UAT`} />
        )}
        <Figure label={report.labels.build} value={k.inScope.toLocaleString()} hint={splitText(k.split.inScope, report.streams)} />
        <Figure label="Executed" value={k.executed.toLocaleString()} hint={`${formatPct(k.execPct)} of ${report.labels.name}`} />
        <Figure label="Pass rate" value={formatPct(k.passPct)} hint={`${k.outcomes.passed.toLocaleString()} passed · ${k.outcomes.failed.toLocaleString()} failed`} />
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={Eye} onClick={onOpen}>
          Open report
        </Button>
        <Button icon={Link2} onClick={onShare}>
          Share link
        </Button>
      </div>
    </section>
  );
}

export function ReportWorkspace({ share }: { share: string | null }) {
  const { settings, spira } = useSettings();
  const projectId = settings?.projectId ?? null;
  const configured = spira?.configured === true;
  const shared = useMemo(() => (share ? decodeShare(share) : null), [share]);

  const [catalogState, setCatalogState] = useState<CatalogState | null>(null);
  const [stored, setStored] = useState<{ projectId: number; options: ReportOptions | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<{ input: ReportInput; changes: ReportChanges | null } | null>(null);
  const [progress, setProgress] = useState<ReportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!configured || projectId === null) return;
    let cancelled = false;
    loadCatalog(projectId).then(
      (catalog) => {
        if (cancelled) return;
        setCatalogState({ projectId, catalog, error: null });
        setStored((current) =>
          current?.projectId === projectId ? current : { projectId, options: shared?.projectId === projectId ? shared.options : loadReportOptions(projectId) },
        );
      },
      (err) => !cancelled && setCatalogState({ projectId, catalog: null, error: errorMessage(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [configured, projectId, reload, shared]);

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

  const resolved = useMemo(() => (options ? resolveReportOptions(options) : null), [options]);
  // Presentation choices apply at once; the report type and releases apply to the data read for them.
  const reportOptions = useMemo(() => {
    if (!data || !options) return null;
    const read = data.input.options;
    return { ...resolveReportOptions({ ...options, kind: read.kind }), baseline: read.baseline, scoped: read.scoped };
  }, [data, options]);
  const report = useMemo(() => {
    if (!data || !reportOptions || data.input.catalog.projectId !== projectId) return null;
    return buildReport({ ...data.input, options: reportOptions });
  }, [data, reportOptions, projectId]);
  const scopeChanged = !!(
    data &&
    resolved &&
    (data.input.options.kind !== resolved.kind || !sameScope(data.input.options.scoped, resolved.scoped) || !sameScope(data.input.options.baseline, resolved.baseline))
  );
  const scopedSets = catalog && resolved ? setsInScope(catalog, resolved.scoped).length : 0;
  const missingPlan = resolved?.kind === "buildVsPlan" && resolved.baseline.releaseId === null;

  const generate = async () => {
    if (!options || !resolved || projectId === null || !catalog || scopedSets === 0 || missingPlan) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setProgress({ step: "Reading releases and test sets", done: 0, total: 1 });
    try {
      const fresh = await loadCatalog(projectId, controller.signal);
      setCatalogState({ projectId, catalog: fresh, error: null });
      const input = await readReportData({ catalog: fresh, options: resolved, mappings: settings?.mappings ?? [], onProgress: setProgress, signal: controller.signal });
      const built = buildReport(input);
      const before = recordSnapshot(built, resolved);
      const previous = previousSnapshot(before, built);
      setData({ input, changes: previous ? { since: previous.at, rows: compareSnapshots(previous, snapshotOf(built)) } : null });
      setViewerOpen(true);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err));
    } finally {
      if (abort.current === controller) setProgress(null);
    }
  };

  const shareLink = async () => {
    if (!options || projectId === null) return;
    const url = `${window.location.origin}/reports?share=${encodeShare(projectId, options)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied. Whoever opens it signs in first, then generates the same report live from Spira.");
    } catch {
      window.prompt("Copy this link to share the report", url);
    }
  };

  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const busy = progress !== null;
  const phaseName = options?.phase.trim() || "Phase 1";
  const fileName = report ? `${report.title} ${report.generatedAt.slice(0, 10)}`.replace(/[\\/:*?"<>|]+/g, "-") : "";

  return (
    <div className="flex flex-col gap-6">
      <div className={clsx("flex flex-col gap-6", viewerOpen && "print:hidden")}>
        <PageHeader
          eyebrow={
            <>
              <FileChartColumn className="size-4" aria-hidden /> Reports
            </>
          }
          title="Executive test report"
          description="Read live from Spira every time. Choose the report, add the header details and generate. Nothing is written to Spira."
        />

        {share && !shared && (
          <Notice tone="danger" title="This report link is not valid">
            It may have been cut short when it was copied. Ask for the link again, or set the report up below.
          </Notice>
        )}
        {shared && projectId !== null && shared.projectId !== projectId && (
          <Notice tone="warning" title="This report link is for another project" action={<ButtonLink href="/settings" icon={Settings2} size="sm">Settings</ButtonLink>}>
            It reports on Spira project {shared.projectId}. Choose that project in Settings, then open the link again.
          </Notice>
        )}
        {shared && shared.projectId === projectId && !data && !busy && (
          <Notice tone="info" title="Report setup from a shared link">
            Generate the report to read it live from Spira with the same report type, releases and settings.
          </Notice>
        )}

        {spira && !configured && (
          <Notice tone="warning" title="Spira is not connected" action={<ButtonLink href="/settings" icon={Settings2} size="sm">Settings</ButtonLink>}>
            The report reads everything from Spira. Connect it in Settings first.
          </Notice>
        )}
        {configured && settings && projectId === null && (
          <Notice tone="warning" title="Choose a project" action={<ButtonLink href="/settings" icon={Settings2} size="sm">Settings</ButtonLink>}>
            Pick the Spira project in Settings, then come back here.
          </Notice>
        )}
        {current?.error && (
          <Notice tone="danger" title="Could not read the project from Spira" action={<Button size="sm" icon={RefreshCw} onClick={() => setReload((n) => n + 1)}>Try again</Button>}>
            {current.error}
          </Notice>
        )}
        {configured && projectId !== null && !current && (
          <div className="surface flex items-center gap-3 p-6 text-sm text-slate-600 dark:text-zinc-400">
            <Spinner /> Reading releases, folders and test sets from Spira…
          </div>
        )}

        {catalog && options && (
          <Section
            title="Report setup"
            description={`${catalog.projectName}: ${catalog.releases.length} releases, ${catalog.testSets.length} test sets. Your choices are kept in this browser.`}
            actions={
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => setReload((n) => n + 1)} disabled={busy}>
                Refresh lists
              </Button>
            }
          >
            <KindPicker value={options.kind} phase={phaseName} onChange={(kind) => update({ kind })} />

            <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="Report title" hint="Empty uses the project name.">
                {(props) => <input {...props} className="input" value={options.title} placeholder={`${catalog.projectName} — Test Report`} onChange={(e) => update({ title: e.target.value })} />}
              </Field>
              <Field label="Cycle" hint="Shown in the header. Empty uses the test sets' folder.">
                {(props) =>
                  options.kind === "plan" ? (
                    <input
                      {...props}
                      className="input"
                      value={options.baselineName}
                      placeholder={resolved ? scopeName(catalog, resolved.scoped) : ""}
                      onChange={(e) => update({ baselineName: e.target.value })}
                    />
                  ) : (
                    <input
                      {...props}
                      className="input"
                      value={options.environment}
                      placeholder={resolved ? scopeName(catalog, resolved.scoped) : ""}
                      onChange={(e) => update({ environment: e.target.value })}
                    />
                  )
                }
              </Field>
              <Field label="Prepared by">
                {(props) => <input {...props} className="input" value={options.preparedBy} onChange={(e) => update({ preparedBy: e.target.value })} />}
              </Field>
              <Field label="Go-live date">
                {(props) => <input {...props} type="date" className="input" value={options.goLive ?? ""} onChange={(e) => update({ goLive: e.target.value || null })} />}
              </Field>
            </div>

            <button
              type="button"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
              className="mt-4 inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white"
            >
              <ChevronDown className={clsx("size-4 transition-transform", moreOpen && "rotate-180")} aria-hidden />
              More options: releases, names, exit targets, status, notes and appendix
            </button>
            {moreOpen && (
              <div className="mt-3 flex flex-col gap-4 border-t border-slate-100 pt-4 dark:border-white/[0.06]">
                <div className="grid gap-4 sm:grid-cols-2">
                  <ReleaseSelect
                    label={`${phaseName} release`}
                    catalog={catalog}
                    releaseId={options.scoped.releaseId}
                    onChange={(releaseId) => update({ scoped: { releaseId, folderId: null } })}
                  />
                  <ReleaseSelect
                    label="Total test plan release"
                    catalog={catalog}
                    releaseId={options.baseline.releaseId}
                    onChange={(releaseId) => update({ baseline: { releaseId, folderId: null } })}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Field label="Build name" hint={`Shown as "This build (Phase 1)", on the report choices and in the defect register.`}>
                    {(props) => <input {...props} className="input" value={options.phase} placeholder="Phase 1" onChange={(e) => update({ phase: e.target.value })} />}
                  </Field>
                  {options.kind === "buildVsPlan" && (
                    <Field label="Total plan cycle" hint="Used in the cycle comparison. Empty uses its test sets' folder.">
                      {(props) => (
                        <input
                          {...props}
                          className="input"
                          value={options.baselineName}
                          placeholder={resolved ? scopeName(catalog, resolved.baseline) : ""}
                          onChange={(e) => update({ baselineName: e.target.value })}
                        />
                      )}
                    </Field>
                  )}
                  <Field
                    label="Executions"
                    hint={report?.window.first ? `Empty reads the run dates: ${report.window.first.slice(0, 10)} to ${report.window.last?.slice(0, 10)}.` : "Empty reads the run dates from Spira."}
                  >
                    {(props) => <input {...props} className="input" value={options.windowText} placeholder="Fri 9 – Sun 11 Oct 2026" onChange={(e) => update({ windowText: e.target.value })} />}
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
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
                  <div className="pt-6">
                    <Switch checked={options.appendix} onChange={(appendix) => update({ appendix })} label="Add appendix" description="Data checks, trend, test sets and failed cases after the four pages." />
                  </div>
                </div>
                <Field label="QA notes" hint="Optional. Shown on the first page, for example scope decisions or build notes.">
                  {(props) => <textarea {...props} rows={3} className="input" value={options.notes} onChange={(e) => update({ notes: e.target.value })} />}
                </Field>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={FileChartColumn} onClick={() => void generate()} busy={busy} disabled={scopedSets === 0 || missingPlan}>
                {data ? "Read Spira again" : "Generate report"}
              </Button>
              {(scopedSets === 0 || missingPlan) && (
                <span className="text-sm text-slate-500">
                  {resolved?.scoped.releaseId === null || missingPlan
                    ? `Choose the ${resolved?.kind === "plan" || missingPlan ? "total test plan" : phaseName} release`
                    : "That release has no test sets in Spira; choose another"}{" "}
                  under{" "}
                  <button type="button" className="cursor-pointer font-medium text-brand-600 underline-offset-2 hover:underline dark:text-brand-400" onClick={() => setMoreOpen(true)}>
                    More options
                  </button>
                  .
                </span>
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
                The report type or releases changed since Spira was read. Read Spira again to report on them; the report you have is still for the previous choice.
              </Notice>
            )}
          </Section>
        )}

        {error && (
          <Notice tone="danger" title="The report could not be read from Spira">
            {error}
          </Notice>
        )}

        {report && <ReportSummary report={report} onOpen={() => setViewerOpen(true)} onShare={() => void shareLink()} />}

        {report && report.defects.rows.length > 0 && options && (
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
        )}

        {!report && catalog && options && !busy && (
          <EmptyState icon={FileChartColumn} title="No report yet">
            Choose the report and generate. Every figure is read from Spira at that moment, and the report opens over this page.
          </EmptyState>
        )}
      </div>

      {viewerOpen && report && (
        <ReportViewer
          report={report}
          changes={data?.changes ?? null}
          siteUrl={spira?.siteUrl ?? null}
          fileName={fileName}
          onShare={() => void shareLink()}
          onExcel={() => void exportReportWorkbook(report, spira?.siteUrl ?? null)}
          onClose={closeViewer}
        />
      )}
    </div>
  );
}
