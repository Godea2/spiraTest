"use client";

import clsx from "clsx";
import { FileChartColumn, Grid3x3, Play, RefreshCw, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { logActivity } from "@/lib/client/activity";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  buildCoverage,
  catalogLooksComplete,
  loadMatrixStore,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  normalizeMatrixPlatform,
  platformCounts,
  platformForDevice,
  replaceCatalog,
  seedCatalogFromDrafts,
  type MatrixCellStatus,
  type MatrixDevice,
  type MatrixNetwork,
  type MatrixStore,
} from "@/lib/client/matrix";
import { buildMatrixReport, type MatrixReport } from "@/lib/domain/matrix-report";
import { listUatDrafts, materializeUatCatalog } from "@/lib/client/uat-build";
import { loadWeekCatalog } from "@/lib/client/week";
import { executionCardsForPlatform, executionCounts } from "@/lib/domain/execution";
import type { Draft } from "@/lib/domain/types";
import { StatusChip } from "../drafts/[id]/execute/runner";
import { MatrixReportViewer } from "../reports/matrix-report-viewer";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const CELL_LABEL: Record<MatrixCellStatus, string> = {
  notStarted: "Not started",
  inProgress: "In progress",
  covered: "Covered",
  failed: "Failed",
};

function draftHasPlatform(draft: Draft, platform: ReturnType<typeof platformForDevice>): boolean {
  return draft.testSets.some((s) => normalizeMatrixPlatform(s.testSetName, s.platform) === platform);
}

/**
 * One job: pick where you are testing, then run the same Spira modules as UAT.
 * Coverage is a summary — not the main interaction.
 */
export function MatrixWorkspace() {
  const { settings, spira } = useSettings();
  const projectId = settings?.projectId ?? null;
  const releaseId = settings?.releaseId ?? null;
  const releaseLabel = settings?.releaseLabel?.trim() || (releaseId !== null ? `RL:${releaseId}` : "");

  const [store, setStore] = useState<MatrixStore | null>(null);
  const [uatDrafts, setUatDrafts] = useState<Draft[]>([]);
  const [tester, setTester] = useState("");
  const [device, setDevice] = useState<MatrixDevice>("Samsung");
  const [network, setNetwork] = useState<MatrixNetwork>("MTN");
  const [moduleId, setModuleId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [matrixReport, setMatrixReport] = useState<MatrixReport | null>(null);
  const [showCoverage, setShowCoverage] = useState(false);
  const autoReloadTried = useRef(false);

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

  useEffect(() => {
    if (projectId === null || releaseId === null) return;
    const existing = listUatDrafts(releaseId);
    if (existing.length > 0) setUatDrafts(existing);
    const seeded = seedCatalogFromDrafts(projectId, existing, { releaseId, releaseLabel });
    if (seeded) setStore(seeded);
  }, [projectId, releaseId, releaseLabel]);

  const coverage = useMemo(() => (store ? buildCoverage(store, releaseId) : null), [store, releaseId]);
  const platforms = useMemo(() => (store ? platformCounts(store.cases) : null), [store]);
  const devicePlatform = platformForDevice(device);
  const plannedForPlatform = platforms ? (devicePlatform === "iOS" ? platforms.ios : platforms.android) : 0;
  const activeCell = coverage?.cells.find((c) => c.device === device && c.network === network) ?? null;
  const incompleteCatalog = !!store?.catalogLoadedAt && store.cases.length > 0 && !catalogLooksComplete(store.cases);
  const releaseMismatch =
    (!!store?.releaseLabel &&
      !!releaseLabel &&
      !store.releaseLabel.includes("0006") &&
      releaseLabel.includes("0006")) ||
    (store?.releaseId != null && releaseId != null && store.releaseId !== releaseId);

  const moduleRows = useMemo(() => {
    return uatDrafts
      .filter((d) => draftHasPlatform(d, devicePlatform))
      .slice()
      .sort((a, b) => a.module.localeCompare(b.module))
      .map((d) => {
        const cards = executionCardsForPlatform(d, devicePlatform);
        const counts = executionCounts(cards, d.execution);
        return { draft: d, cards, counts, executed: counts.total - counts.notRun };
      })
      .filter((row) => row.cards.length > 0);
  }, [uatDrafts, devicePlatform]);

  // Keep module selection valid when device (platform) changes.
  useEffect(() => {
    if (moduleRows.length === 0) {
      setModuleId("");
      return;
    }
    if (!moduleRows.some((r) => r.draft.id === moduleId)) {
      setModuleId(moduleRows[0].draft.id);
    }
  }, [moduleRows, moduleId]);

  const selectedModule = moduleRows.find((r) => r.draft.id === moduleId) ?? moduleRows[0] ?? null;
  const runHref = selectedModule
    ? `/matrix/run/${selectedModule.draft.id}?device=${encodeURIComponent(device)}&network=${encodeURIComponent(network)}`
    : null;

  const loadCatalog = useCallback(async () => {
    if (projectId === null || releaseId === null) {
      setLoadError("Choose Prod (1.0.0.0.0006) in Settings and save first.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const catalog = await loadWeekCatalog(projectId, releaseId, releaseLabel);
      const next = replaceCatalog(projectId, catalog);
      setStore(next);
      const drafts = materializeUatCatalog(catalog);
      setUatDrafts(drafts);
      const counts = platformCounts(next.cases);
      logActivity({
        type: "week.loaded",
        message: `Matrix: loaded ${next.cases.length} Spira cases in ${catalog.modules.length} modules for ${catalog.releaseLabel}.`,
        details: {
          releaseId: catalog.releaseId,
          cases: next.cases.length,
          modules: catalog.modules.length,
          source: "matrix",
        },
      });
      toast.success(
        `Loaded ${plural(catalog.modules.length, "module")} · ${catalog.caseCount.toLocaleString()} cases · ${counts.android.toLocaleString()} Android · ${counts.ios.toLocaleString()} iOS`,
      );
      if (!catalogLooksComplete(next.cases)) {
        toast.error("Still incomplete after reload — Spira did not return full iOS/Android modules. Try again or check Prod–Phase 1 in Spira.");
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, releaseId, releaseLabel]);

  useEffect(() => {
    if (!spira?.configured || projectId === null || releaseId === null || store === null || loading) return;
    if (!store.catalogLoadedAt) {
      void loadCatalog();
      return;
    }
    if (store.catalogLoadedAt && uatDrafts.length === 0) {
      void loadCatalog();
      return;
    }
    if (incompleteCatalog && !autoReloadTried.current) {
      autoReloadTried.current = true;
      void loadCatalog();
    }
  }, [spira?.configured, projectId, releaseId, store, uatDrafts.length, loading, incompleteCatalog, loadCatalog]);

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };

  const generateReport = () => {
    if (projectId === null || !store) return;
    if (!store.catalogLoadedAt && store.results.length === 0) {
      toast.error("Load Spira cases first.");
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
        Save project and Prod release 1.0.0.0.0006 in Settings first.
      </EmptyState>
    );
  }

  const hasCatalog = !!store?.catalogLoadedAt && store.cases.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Matrix"
        description="Pick device and network, then run the same Spira modules as UAT. Results go to Spira and count for that cell."
        actions={
          <>
            <Button
              icon={FileChartColumn}
              onClick={generateReport}
              disabled={!store?.catalogLoadedAt && !(store?.results.length)}
            >
              Report
            </Button>
            <Button icon={RefreshCw} onClick={() => void loadCatalog()} busy={loading} disabled={!spira?.configured}>
              {hasCatalog ? "Reload from Spira" : "Load from Spira"}
            </Button>
          </>
        }
      />

      {loadError && <Notice tone="danger">{loadError}</Notice>}
      {!spira?.configured && <Notice tone="warning">Connect Spira in Settings before loading cases.</Notice>}
      {(releaseMismatch || (store?.releaseLabel && /0004/.test(store.releaseLabel))) && (
        <Notice
          tone="warning"
          title="Wrong release loaded"
          action={
            <Button size="sm" variant="primary" icon={RefreshCw} busy={loading} onClick={() => void loadCatalog()}>
              Load Prod 0006
            </Button>
          }
        >
          Board has <strong>{store?.releaseLabel || "another release"}</strong>
          {releaseLabel ? (
            <>
              ; Settings is <strong>{releaseLabel}</strong>
            </>
          ) : null}
          . Use Prod <strong>1.0.0.0.0006</strong>.
        </Notice>
      )}
      {incompleteCatalog && !loading && (
        <Notice
          tone="warning"
          title="Catalogue is incomplete — click Reload"
          action={
            <Button size="sm" variant="primary" icon={RefreshCw} busy={loading} onClick={() => void loadCatalog()}>
              Reload full catalogue
            </Button>
          }
        >
          Matrix only has{" "}
          <strong>
            {platforms?.android ?? 0} Android · {platforms?.ios ?? 0} iOS
          </strong>{" "}
          right now (need both platforms across ~7 modules like Spira Prod–Phase 1). Click{" "}
          <strong>Reload full catalogue</strong>, wait for the toast with Android and iOS counts, then pick a module.
        </Notice>
      )}

      <Section
        title="Where are you testing?"
        description={
          hasCatalog
            ? `${store?.releaseLabel || releaseLabel} · ${platforms?.android ?? 0} Android · ${platforms?.ios ?? 0} iOS · ${plural(moduleRows.length, "module")} for ${devicePlatform}`
            : "Load Spira cases once — every network shares that same catalogue."
        }
      >
        {!hasCatalog ? (
          <EmptyState
            icon={Grid3x3}
            title="Load Spira cases"
            action={
              <Button icon={RefreshCw} onClick={() => void loadCatalog()} busy={loading} disabled={!spira?.configured || releaseId === null}>
                Load from Spira
              </Button>
            }
          >
            Pulls all Prod modules (Accounts, Bills, Cards, Onboarding, …) for Android and iOS — same source as UAT build.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <fieldset className="min-w-0">
                <legend className="mb-2 text-xs font-medium text-slate-500 dark:text-zinc-500">Device</legend>
                <div className="flex flex-wrap gap-2">
                  {MATRIX_DEVICES.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDevice(d)}
                      className={clsx(
                        "rounded-lg border px-3 py-2 text-sm font-medium transition",
                        device === d
                          ? "border-brand-600 bg-brand-600 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200",
                      )}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </fieldset>

              <fieldset className="min-w-0">
                <legend className="mb-2 text-xs font-medium text-slate-500 dark:text-zinc-500">Network</legend>
                <div className="flex flex-wrap gap-2">
                  {MATRIX_NETWORKS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setNetwork(n)}
                      className={clsx(
                        "rounded-lg border px-3 py-2 text-sm font-medium transition",
                        network === n
                          ? "border-brand-600 bg-brand-600 text-white"
                          : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="flex min-w-0 flex-col gap-1.5 text-sm sm:col-span-2 lg:col-span-1">
                <span className="text-xs font-medium text-slate-500 dark:text-zinc-500">Module</span>
                <select
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 dark:border-white/10 dark:bg-white/[0.04]"
                  value={selectedModule?.draft.id ?? ""}
                  onChange={(e) => setModuleId(e.target.value)}
                  disabled={moduleRows.length === 0}
                >
                  {moduleRows.length === 0 ? (
                    <option value="">No {devicePlatform} modules</option>
                  ) : (
                    moduleRows.map(({ draft: d, counts }) => (
                      <option key={d.id} value={d.id}>
                        {d.module} ({counts.total})
                      </option>
                    ))
                  )}
                </select>
              </label>

              <label className="flex min-w-0 flex-col gap-1.5 text-sm">
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
            </div>

            {moduleRows.length === 0 ? (
              <Notice
                tone="warning"
                title={`No ${devicePlatform} modules yet`}
                action={
                  <Button size="sm" variant="primary" icon={RefreshCw} busy={loading} onClick={() => void loadCatalog()}>
                    Reload from Spira
                  </Button>
                }
              >
                Expected Accounts, Bill Payment, Cards, Core Banking, Onboarding, Profile, Transfers.
              </Notice>
            ) : (
              <>
                <fieldset>
                  <legend className="mb-2 text-xs font-medium text-slate-500 dark:text-zinc-500">
                    Or tap a module ({devicePlatform})
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {moduleRows.map(({ draft: d, counts }) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setModuleId(d.id)}
                        className={clsx(
                          "rounded-lg border px-3 py-2 text-left text-sm transition",
                          (selectedModule?.draft.id ?? moduleId) === d.id
                            ? "border-brand-600 bg-brand-50 text-brand-900 dark:bg-brand-500/15 dark:text-brand-100"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200",
                        )}
                      >
                        <span className="font-medium">{d.module}</span>
                        <span className="ml-1.5 text-xs text-slate-500">{counts.total}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>

                {selectedModule && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold text-slate-900 dark:text-zinc-100">
                        {selectedModule.draft.module}
                        <span className="font-normal text-slate-500">
                          {" "}
                          · {device} · {network}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {plural(selectedModule.counts.total, "case")} · {selectedModule.executed} done
                        {selectedModule.counts.notRun > 0 ? ` · ${selectedModule.counts.notRun} left` : ""}
                        {" · "}
                        Cell {activeCell ? CELL_LABEL[activeCell.status] : "Not started"} ({activeCell?.executed ?? 0}/
                        {plannedForPlatform || "—"})
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
                        {selectedModule.counts.passed > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <StatusChip status="passed" /> {selectedModule.counts.passed}
                          </span>
                        )}
                        {selectedModule.counts.failed > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <StatusChip status="failed" /> {selectedModule.counts.failed}
                          </span>
                        )}
                        {selectedModule.counts.blocked > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <StatusChip status="blocked" /> {selectedModule.counts.blocked}
                          </span>
                        )}
                        {selectedModule.counts.notRun > 0 && (
                          <Badge tone="neutral">{selectedModule.counts.notRun} to run</Badge>
                        )}
                      </div>
                    </div>
                    {runHref && (
                      <ButtonLink href={runHref} variant="primary" icon={Play}>
                        {selectedModule.executed ? "Continue module" : "Run module"}
                      </ButtonLink>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end">
              <button
                type="button"
                className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
                onClick={() => setShowCoverage((v) => !v)}
              >
                {showCoverage ? "Hide coverage cells" : "Show coverage cells"}
              </button>
            </div>

            {showCoverage && coverage && (
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10">
                <table className="w-full min-w-[28rem] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 dark:border-white/5 dark:bg-white/[0.03]">
                      <th className="p-2 text-left text-xs font-medium text-slate-500">Device</th>
                      {MATRIX_NETWORKS.map((n) => (
                        <th key={n} className="p-2 text-center text-xs font-medium text-slate-500">
                          {n}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {MATRIX_DEVICES.map((d) => (
                      <tr key={d} className="border-b border-slate-100 last:border-0 dark:border-white/5">
                        <th className="p-2 text-left font-medium text-slate-800 dark:text-zinc-100">{d}</th>
                        {MATRIX_NETWORKS.map((n) => {
                          const cell = coverage.cells.find((c) => c.device === d && c.network === n)!;
                          const planned =
                            platformForDevice(d) === "iOS" ? (platforms?.ios ?? 0) : (platforms?.android ?? 0);
                          const selected = device === d && network === n;
                          return (
                            <td key={n} className="p-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setDevice(d);
                                  setNetwork(n);
                                }}
                                className={clsx(
                                  "w-full rounded-lg border px-2 py-1.5 text-center text-xs tabular-nums transition",
                                  selected
                                    ? "border-brand-500 bg-brand-50 text-brand-900 ring-2 ring-brand-500 dark:bg-brand-500/10 dark:text-brand-100"
                                    : "border-transparent hover:bg-slate-50 dark:hover:bg-white/[0.04]",
                                )}
                              >
                                {cell.executed}/{planned || "—"}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      {loading && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/20 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-soft dark:border-white/10 dark:bg-zinc-900">
            <Spinner className="size-5" />
            <span className="text-sm font-medium">Loading all modules from Spira…</span>
          </div>
        </div>
      )}

      {matrixReport && <MatrixReportViewer report={matrixReport} onClose={() => setMatrixReport(null)} />}
    </div>
  );
}
