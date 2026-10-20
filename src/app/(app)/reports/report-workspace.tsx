"use client";

import clsx from "clsx";
import { CircleCheck, Eye, FileChartColumn, GitCompareArrows, Layers, Link2, NotebookPen, RefreshCw, Settings2, Target, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Collapsible, EmptyState, Field, Notice, PageHeader, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { listBuckets } from "@/lib/client/defect-buckets";
import { exportReportWorkbook, loadCatalog, loadReportOptions, readReportData, recordSnapshot, saveReportOptions, type ReportProgress } from "@/lib/client/report";
import {
  buildReport,
  compareSnapshots,
  decodeShare,
  formatPct,
  initialReportOptions,
  previousSnapshot,
  reportFileName,
  resolveReportOptions,
  sameScope,
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
import type { DefectBucket } from "@/lib/domain/incident-register";
import type { ReportCatalog } from "@/lib/domain/types";

/** Snapshot the chosen Review bucket onto report options so generate/share use the same IDs. */
function withDefectBucket(options: ReportOptions, buckets: DefectBucket[], bucketId: string | null): ReportOptions {
  const bucket = (bucketId && buckets.find((b) => b.id === bucketId)) || buckets[0] || null;
  if (!bucket) {
    return { ...options, defectBucketId: null, defectBucketName: "", defectRegisterIds: [] };
  }
  return {
    ...options,
    defectBucketId: bucket.id,
    defectBucketName: bucket.name,
    defectRegisterIds: [...bucket.incidentIds],
  };
}
import { type ReportChanges } from "./report-document";
import { ReportViewer } from "./report-viewer";
import { ShareDialog, type ShareRequest } from "./share-dialog";

type CatalogState = { projectId: number; catalog: ReportCatalog | null; error: string | null };

const STATUS_TONE: Record<RagStatus, "success" | "warning" | "danger"> = { green: "success", amber: "warning", red: "danger" };

/** The build's name on the report and its choices. */
const PHASE = "Phase 1";

const KINDS: { kind: ReportKind; icon: LucideIcon; title: string }[] = [
  { kind: "build", icon: Target, title: `${PHASE}: scoped test cases` },
  { kind: "buildVsPlan", icon: GitCompareArrows, title: `${PHASE}: scoped vs total test plan` },
  { kind: "plan", icon: Layers, title: "Total test plan" },
];

function KindPicker({ value, onChange }: { value: ReportKind; onChange: (kind: ReportKind) => void }) {
  return (
    <div role="radiogroup" aria-label="Report" className="grid gap-3 md:grid-cols-3">
      {KINDS.map(({ kind, icon: Icon, title }) => {
        const selected = value === kind;
        const featured = kind === "buildVsPlan";
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(kind)}
            className={clsx(
              "relative flex min-h-28 cursor-pointer flex-col justify-between gap-4 rounded-xl p-4 text-left transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:focus-visible:ring-offset-zinc-900",
              featured
                ? "bg-gradient-to-br from-amber-500 via-orange-500 to-orange-600 text-white shadow-lg shadow-orange-500/30 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-orange-500/40"
                : "well hover:border-slate-300 dark:hover:border-white/20",
              selected && (featured ? "ring-4 ring-orange-300/70 dark:ring-orange-400/50" : "ring-2 ring-brand-500 dark:ring-brand-400"),
            )}
          >
            <span
              className={clsx(
                "grid size-9 place-items-center rounded-lg",
                featured ? "bg-white/20 ring-1 ring-white/30" : "bg-white text-slate-500 ring-1 ring-slate-200 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10",
              )}
            >
              <Icon className="size-[18px]" aria-hidden />
            </span>
            <span className="flex items-end justify-between gap-2">
              <span className="text-[15px] leading-snug font-semibold">{title}</span>
              {selected && <CircleCheck className={clsx("size-5 shrink-0", featured ? "text-white" : "text-brand-600 dark:text-brand-400")} aria-hidden />}
            </span>
          </button>
        );
      })}
    </div>
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
  const [stored, setStored] = useState<{ projectId: number; options: ReportOptions | null; fromLink: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<{ input: ReportInput; changes: ReportChanges | null } | null>(null);
  const [progress, setProgress] = useState<ReportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [buckets, setBuckets] = useState<DefectBucket[]>([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (projectId === null) {
      setBuckets([]);
      return;
    }
    setBuckets(listBuckets(projectId));
  }, [projectId, reload, viewerOpen]);

  useEffect(() => {
    if (!configured || projectId === null) return;
    let cancelled = false;
    loadCatalog(projectId).then(
      (catalog) => {
        if (cancelled) return;
        setCatalogState({ projectId, catalog, error: null });
        setStored((current) => {
          if (current?.projectId === projectId) return current;
          const fromLink = shared?.projectId === projectId;
          return { projectId, options: fromLink ? shared.options : loadReportOptions(projectId), fromLink };
        });
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
  const planRelease = settings?.planReleaseId ?? null;
  // The releases follow Settings (the working release, and the total test plan release);
  // only the report and its header are chosen here.
  const options = useMemo((): ReportOptions | null => {
    if (!catalog || stored?.projectId !== projectId) return null;
    const saved = stored.options;
    if (stored.fromLink && saved) return saved;
    const auto = { ...initialReportOptions(catalog.releases, settingsRelease, planRelease), phase: PHASE };
    if (!saved) return withDefectBucket(auto, buckets, null);
    const { kind, title, preparedBy, goLive, defectNotes, defectBucketId, defectBucketName, defectRegisterIds } = saved;
    return withDefectBucket(
      { ...auto, kind, title, preparedBy, goLive, defectNotes, defectBucketId, defectBucketName, defectRegisterIds },
      buckets,
      defectBucketId ?? null,
    );
  }, [catalog, stored, projectId, settingsRelease, planRelease, buckets]);

  const update = (patch: Partial<ReportOptions>) => {
    if (!options || projectId === null || !stored) return;
    const next = { ...options, ...patch };
    setStored({ projectId, options: next, fromLink: stored.fromLink });
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
      const freshBuckets = listBuckets(projectId);
      setBuckets(freshBuckets);
      const withBucket = withDefectBucket(resolved, freshBuckets, options.defectBucketId);
      setStored({ projectId, options: withBucket, fromLink: stored?.fromLink ?? false });
      try {
        saveReportOptions(projectId, withBucket);
      } catch {
        // storage full: generate still uses withBucket for this run
      }
      const input = await readReportData({ catalog: fresh, options: withBucket, mappings: settings?.mappings ?? [], onProgress: setProgress, signal: controller.signal });
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

  // The link carries the report as it was read (its type), and the module mappings of its test sets.
  const shareRequest = useMemo((): ShareRequest | null => {
    if (!options || !catalog || projectId === null) return null;
    const shared = { ...options, kind: data?.input.options.kind ?? options.kind };
    const scopes = resolveReportOptions(shared);
    const ids = new Set([...setsInScope(catalog, scopes.scoped), ...setsInScope(catalog, scopes.baseline)].map((s) => s.testSetId));
    return { projectId, options: shared, mappings: (settings?.mappings ?? []).filter((m) => ids.has(m.testSetId)) };
  }, [options, catalog, projectId, data, settings?.mappings]);

  const closeViewer = useCallback(() => setViewerOpen(false), []);
  const busy = progress !== null;
  const fileName = report ? reportFileName(report) : "";
  const releaseOf = (id: number | null) => catalog?.releases.find((r) => r.releaseId === id)?.versionNumber;
  const setupProblem =
    options && resolved
      ? resolved.kind !== "plan" && options.scoped.releaseId === null
        ? "Choose the Phase 1 release in Settings."
        : resolved.kind !== "build" && options.baseline.releaseId === null
          ? `No total test plan release was found for ${releaseOf(options.scoped.releaseId) ?? "the Phase 1 release"}. Choose the total test plan release in Settings.`
          : scopedSets === 0
            ? `Release ${releaseOf(resolved.scoped.releaseId) ?? ""} has no test sets in Spira. Check the Phase 1 release in Settings.`
            : null
      : null;

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
            actions={
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => setReload((n) => n + 1)} disabled={busy}>
                Refresh lists
              </Button>
            }
          >
            <KindPicker value={options.kind} onChange={(kind) => update({ kind })} />

            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Report title" hint="Empty uses the project name.">
                {(props) => <input {...props} className="input" value={options.title} placeholder={`${catalog.projectName} — Test Report`} onChange={(e) => update({ title: e.target.value })} />}
              </Field>
              <Field label="Prepared by">
                {(props) => <input {...props} className="input" value={options.preparedBy} onChange={(e) => update({ preparedBy: e.target.value })} />}
              </Field>
              <Field label="Go-live date">
                {(props) => <input {...props} type="date" className="input" value={options.goLive ?? ""} onChange={(e) => update({ goLive: e.target.value || null })} />}
              </Field>
              <Field
                label="Defects Review bucket"
                hint={buckets.length === 0 ? "Create a bucket on the Defects page first." : "All-time defects KPI uses this bucket."}
              >
                {(props) => (
                  <select
                    {...props}
                    className="input"
                    value={options.defectBucketId ?? ""}
                    disabled={buckets.length === 0}
                    onChange={(e) => update(withDefectBucket(options, buckets, e.target.value || null))}
                  >
                    {buckets.length === 0 ? <option value="">No buckets yet</option> : null}
                    {buckets.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.incidentIds.length})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>

            {setupProblem && (
              <Notice tone="warning" className="mt-5" action={<ButtonLink href="/settings" icon={Settings2} size="sm">Settings</ButtonLink>}>
                {setupProblem}
              </Notice>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={FileChartColumn} onClick={() => void generate()} busy={busy} disabled={setupProblem !== null}>
                {data ? "Read Spira again" : "Generate report"}
              </Button>
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

        {report && <ReportSummary report={report} onOpen={() => setViewerOpen(true)} onShare={() => setShareOpen(true)} />}

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
          onShare={() => setShareOpen(true)}
          onExcel={() => void exportReportWorkbook(report, spira?.siteUrl ?? null)}
          onClose={closeViewer}
        />
      )}
      {shareOpen && shareRequest && <ShareDialog request={shareRequest} onClose={() => setShareOpen(false)} />}
    </div>
  );
}
