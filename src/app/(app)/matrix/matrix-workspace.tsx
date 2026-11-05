"use client";

import clsx from "clsx";
import { FileChartColumn, Grid3x3, Play, RefreshCw, Smartphone, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  buildCoverage,
  deleteMatrixSession,
  environmentLabel,
  loadMatrixStore,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  MATRIX_PACK_LABEL,
  MATRIX_PACKS,
  modulesInCatalog,
  replaceCatalog,
  sessionCounts,
  startMatrixSession,
  type MatrixCellStatus,
  type MatrixDevice,
  type MatrixNetwork,
  type MatrixPack,
  type MatrixSession,
  type MatrixStore,
} from "@/lib/client/matrix";
import { buildMatrixReport, type MatrixReport } from "@/lib/domain/matrix-report";
import { loadWeekCatalog } from "@/lib/client/week";
import { MatrixReportViewer } from "../reports/matrix-report-viewer";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const CELL_STYLE: Record<MatrixCellStatus, string> = {
  notStarted: "border-slate-200 bg-slate-50 text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-500",
  inProgress: "border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-400/30 dark:bg-indigo-500/10 dark:text-indigo-200",
  covered: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200",
  failed: "border-red-200 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200",
};

const CELL_LABEL: Record<MatrixCellStatus, string> = {
  notStarted: "Not started",
  inProgress: "In progress",
  covered: "Covered",
  failed: "Failed",
};

export function MatrixWorkspace() {
  const router = useRouter();
  const { settings, spira } = useSettings();
  const projectId = settings?.projectId ?? null;
  const releaseId = settings?.releaseId ?? null;
  const releaseLabel = settings?.releaseLabel?.trim() || (releaseId !== null ? `RL:${releaseId}` : "");

  const [store, setStore] = useState<MatrixStore | null>(null);
  const [tester, setTester] = useState("");
  const [device, setDevice] = useState<MatrixDevice>("Samsung");
  const [network, setNetwork] = useState<MatrixNetwork>("MTN");
  const [pack, setPack] = useState<MatrixPack>("smoke");
  const [module, setModule] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [matrixReport, setMatrixReport] = useState<MatrixReport | null>(null);

  useEffect(() => {
    setTester(getTester());
  }, []);

  useEffect(() => {
    if (projectId === null) {
      setStore(null);
      return;
    }
    setStore(loadMatrixStore(projectId));
  }, [projectId]);

  const coverage = useMemo(() => (store ? buildCoverage(store, releaseId) : null), [store, releaseId]);
  const modules = useMemo(() => (store ? modulesInCatalog(store.cases) : []), [store]);

  const loadCatalog = useCallback(async () => {
    if (projectId === null || releaseId === null) {
      setLoadError("Choose the release under test in Settings (Prod 1.0.0.0.0006) and save first.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const catalog = await loadWeekCatalog(projectId, releaseId, releaseLabel);
      const next = replaceCatalog(projectId, catalog);
      setStore(next);
      toast.success(`Loaded ${plural(next.cases.length, "case")} from Spira`);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, releaseId, releaseLabel]);

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };

  const start = () => {
    if (projectId === null) return;
    setStarting(true);
    try {
      const { session } = startMatrixSession({
        projectId,
        device,
        network,
        pack,
        module: pack === "module" ? module : null,
        tester,
      });
      setStore(loadMatrixStore(projectId));
      toast.success(`Session ready: ${environmentLabel(device, network)}`);
      router.push(`/matrix/${session.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setStarting(false);
    }
  };

  const removeSession = (session: MatrixSession) => {
    if (projectId === null) return;
    if (!confirm(`Remove session ${environmentLabel(session.device, session.network)}? Results for that cell are kept.`)) return;
    setStore(deleteMatrixSession(projectId, session.id));
  };

  const generateReport = () => {
    if (projectId === null || !store) return;
    if (!store.catalogLoadedAt && store.results.length === 0) {
      toast.error("Load Spira cases first, then execute at least one cell.");
      return;
    }
    const built = buildMatrixReport(store, {
      projectId,
      projectName: "Project-Simba",
      preparedBy: tester,
      environment: store.releaseLabel || releaseLabel,
      releaseId: store.releaseId ?? releaseId,
    });
    setMatrixReport(built);
    toast.success("Matrix report ready");
  };

  if (!settings || projectId === null) {
    return (
      <EmptyState icon={Grid3x3} title="Matrix coverage" action={<ButtonLink href="/settings">Open Settings</ButtonLink>}>
        Save a project and release in Settings first, then load Spira cases for device × network execution.
      </EmptyState>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Matrix"
        description="Execute Spira cases against device and network combinations. Results stay in this app so coverage is visible without cloning test sets in Spira."
        actions={
          <>
            <Button
              icon={FileChartColumn}
              onClick={generateReport}
              disabled={!store?.catalogLoadedAt && !(store?.results.length)}
              title="Executive matrix report (same template as Reports): PDF and Excel"
            >
              Generate report
            </Button>
            <Button icon={RefreshCw} onClick={() => void loadCatalog()} busy={loading} disabled={!spira?.configured}>
              {store?.catalogLoadedAt ? "Reload cases" : "Load Spira cases"}
            </Button>
          </>
        }
      />

      {loadError && <Notice tone="danger">{loadError}</Notice>}
      {!spira?.configured && <Notice tone="warning">Connect Spira in Settings before loading cases.</Notice>}

      <Section
        title="Coverage board"
        description={`${releaseLabel || "Current release"} · ${coverage ? `${coverage.coveredCells} covered · ${coverage.executedCells} started · ${coverage.failedCells} with failures of ${coverage.totalCells} cells` : "Load cases to size the smoke pack."}`}
      >
        {!coverage || (!store?.catalogLoadedAt && coverage.executedCells === 0) ? (
          <EmptyState
            icon={Smartphone}
            title="No catalogue yet"
            action={
              <Button icon={RefreshCw} onClick={() => void loadCatalog()} busy={loading} disabled={!spira?.configured || releaseId === null}>
                Load Spira cases
              </Button>
            }
          >
            Load iOS/Android cases from the Settings release. Smoke sessions then pick carrier-sensitive journeys per device.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="p-2 text-left text-xs font-medium text-slate-500 dark:text-zinc-500">Device \\ Network</th>
                  {MATRIX_NETWORKS.map((n) => (
                    <th key={n} className="p-2 text-center text-xs font-medium text-slate-500 dark:text-zinc-500">
                      {n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX_DEVICES.map((d) => (
                  <tr key={d}>
                    <th className="p-2 text-left text-sm font-medium text-slate-800 dark:text-zinc-100">{d}</th>
                    {MATRIX_NETWORKS.map((n) => {
                      const cell = coverage.cells.find((c) => c.device === d && c.network === n)!;
                      return (
                        <td key={n} className="p-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setDevice(d);
                              setNetwork(n);
                            }}
                            className={clsx(
                              "flex w-full flex-col items-center gap-0.5 rounded-lg border px-2 py-2 text-center transition hover:ring-2 hover:ring-brand-500/40",
                              CELL_STYLE[cell.status],
                              device === d && network === n && "ring-2 ring-brand-500",
                            )}
                            title={`${d} · ${n}: ${CELL_LABEL[cell.status]}`}
                          >
                            <span className="text-[11px] font-semibold uppercase tracking-wide">{CELL_LABEL[cell.status]}</span>
                            <span className="text-xs tabular-nums">
                              {cell.executed}/{cell.planned || "—"}
                            </span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-slate-500 dark:text-zinc-500">
              Click a cell to pre-select it for a new session. Covered means smoke (or the pack you ran) is fully executed with no failures.
            </p>
          </div>
        )}
      </Section>

      <Section title="Start session" description="Lock device and network, then run the selected pack. Marks are stored here — not written back to Spira.">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Device</span>
            <select
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]"
              value={device}
              onChange={(e) => setDevice(e.target.value as MatrixDevice)}
            >
              {MATRIX_DEVICES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Network</span>
            <select
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]"
              value={network}
              onChange={(e) => setNetwork(e.target.value as MatrixNetwork)}
            >
              {MATRIX_NETWORKS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Pack</span>
            <select
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]"
              value={pack}
              onChange={(e) => setPack(e.target.value as MatrixPack)}
            >
              {MATRIX_PACKS.map((p) => (
                <option key={p} value={p}>
                  {MATRIX_PACK_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          {pack === "module" ? (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Module</span>
              <select
                className="h-10 rounded-xl border border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]"
                value={module}
                onChange={(e) => setModule(e.target.value)}
              >
                <option value="">Select module…</option>
                {modules.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Tester</span>
              <div className="relative">
                <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
                <input
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white pr-3 pl-9 dark:border-white/10 dark:bg-white/[0.04]"
                  value={tester}
                  onChange={(e) => changeTester(e.target.value)}
                  placeholder="Your name"
                />
              </div>
            </label>
          )}
        </div>
        {pack === "module" && (
          <label className="mt-4 flex flex-col gap-1.5 text-sm">
            <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Tester</span>
            <div className="relative">
              <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full rounded-xl border border-slate-200 bg-white pr-3 pl-9 dark:border-white/10 dark:bg-white/[0.04]"
                value={tester}
                onChange={(e) => changeTester(e.target.value)}
                placeholder="Your name"
              />
            </div>
          </label>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={Play}
            busy={starting}
            disabled={!store?.catalogLoadedAt || (pack === "module" && !module) || starting}
            onClick={start}
          >
            Start {environmentLabel(device, network)}
          </Button>
          <Badge tone="neutral">
            {store?.catalogLoadedAt
              ? `${plural(store.cases.length, "case")} loaded · ${releaseLabel}`
              : "Catalogue not loaded"}
          </Badge>
        </div>
      </Section>

      <Section title="Sessions" description="Continue a session or remove it from the list. Cell results remain on the coverage board.">
        {!store?.sessions.length ? (
          <p className="text-sm text-slate-500 dark:text-zinc-500">No sessions yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {store.sessions.map((session) => {
              const counts = sessionCounts(session, store.results);
              return (
                <li key={session.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/matrix/${session.id}`} className="font-medium text-slate-900 hover:underline dark:text-white">
                        {environmentLabel(session.device, session.network)}
                      </Link>
                      <Badge tone="neutral">{MATRIX_PACK_LABEL[session.pack]}</Badge>
                      {session.module && <Badge tone="brand">{session.module}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-500">
                      {counts.executed}/{counts.total} executed · {session.releaseLabel}
                      {session.tester ? ` · ${session.tester}` : ""}
                    </p>
                  </div>
                  <ButtonLink href={`/matrix/${session.id}`} size="sm" variant="primary" icon={Play}>
                    {counts.executed ? "Continue" : "Run"}
                  </ButtonLink>
                  <Button size="sm" variant="ghostDanger" icon={Trash2} onClick={() => removeSession(session)} aria-label="Remove session" />
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {loading && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/20 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-soft dark:border-white/10 dark:bg-zinc-900">
            <Spinner className="size-5" />
            <span className="text-sm font-medium">Loading cases from Spira…</span>
          </div>
        </div>
      )}

      {matrixReport && <MatrixReportViewer report={matrixReport} onClose={() => setMatrixReport(null)} />}
    </div>
  );
}
