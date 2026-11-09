"use client";

import clsx from "clsx";
import { FileChartColumn, Grid3x3, Play, RefreshCw, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { logActivity } from "@/lib/client/activity";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import { setActiveMatrixCell } from "@/lib/client/matrix-context";
import {
  buildCoverage,
  catalogLooksComplete,
  ensureMatrixBucket,
  isProdMatrixModule,
  loadMatrixStore,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  matrixModuleLabel,
  normalizeMatrixPlatform,
  platformCounts,
  platformForDevice,
  prodModuleLabel,
  replaceCatalog,
  seedCatalogFromDrafts,
  type MatrixCellStatus,
  type MatrixDevice,
  type MatrixNetwork,
  type MatrixStore,
} from "@/lib/client/matrix";
import { buildMatrixReport, type MatrixReport } from "@/lib/domain/matrix-report";
import { CYCLE_PRESETS, detectCycle, type CycleId } from "@/lib/domain/settings";
import { listUatDrafts, materializeUatCatalog } from "@/lib/client/uat-build";
import { loadWeekCatalog } from "@/lib/client/week";
import { executionCardsForPlatform, executionCounts } from "@/lib/domain/execution";
import type { Draft } from "@/lib/domain/types";
import { StatusChip } from "../drafts/[id]/execute/runner";
import { MatrixReportViewer } from "../reports/matrix-report-viewer";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Soft cycle detect from Settings (same rules as week catalog load). */
function cycleFromSettings(releaseId: number | null, releaseLabel: string): CycleId | null {
  if (releaseId === CYCLE_PRESETS.uat.releaseId || /1\.0\.0\.0\.0004/.test(releaseLabel)) return "uat";
  if (/1\.0\.0\.0\.0006/.test(releaseLabel)) return "prod";
  if (releaseId === CYCLE_PRESETS.sit.releaseId || /1\.0\.0\.0002/.test(releaseLabel)) return "sit";
  return detectCycle(releaseId, []);
}

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
  const router = useRouter();
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

  const cycle = cycleFromSettings(releaseId, releaseLabel);
  const cycleLabel = cycle ? CYCLE_PRESETS[cycle].label : "this release";
  const restrictToProdModules = cycle === "prod" || cycle === "uat";

  const coverage = useMemo(() => (store ? buildCoverage(store, releaseId) : null), [store, releaseId]);
  const platforms = useMemo(() => (store ? platformCounts(store.cases) : null), [store]);
  const devicePlatform = platformForDevice(device);
  const plannedForPlatform = platforms ? (devicePlatform === "iOS" ? platforms.ios : platforms.android) : 0;
  const activeCell = coverage?.cells.find((c) => c.device === device && c.network === network) ?? null;
  const incompleteCatalog =
    restrictToProdModules && !!store?.catalogLoadedAt && store.cases.length > 0 && !catalogLooksComplete(store.cases);
  const releaseMismatch = store?.releaseId != null && releaseId != null && store.releaseId !== releaseId;

  const moduleRows = useMemo(() => {
    return uatDrafts
      .filter((d) => draftHasPlatform(d, devicePlatform) && (!restrictToProdModules || isProdMatrixModule(d.module)))
      .slice()
      .sort((a, b) => matrixModuleLabel(a.module).localeCompare(matrixModuleLabel(b.module)))
      .map((d) => {
        const cards = executionCardsForPlatform(d, devicePlatform);
        const counts = executionCounts(cards, d.execution);
        return { draft: d, cards, counts, executed: counts.total - counts.notRun };
      })
      .filter((row) => row.cards.length > 0);
  }, [uatDrafts, devicePlatform, restrictToProdModules]);

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
  const [openingBucket, setOpeningBucket] = useState(false);

  const openBucket = () => {
    if (!selectedModule || projectId === null || releaseId === null) return;
    const moduleName = prodModuleLabel(selectedModule.draft.module) ?? matrixModuleLabel(selectedModule.draft.module);
    setOpeningBucket(true);
    try {
      const { created } = ensureMatrixBucket({
        projectId,
        device,
        network,
        module: moduleName,
        tester,
      });
      setActiveMatrixCell({
        projectId,
        releaseId,
        releaseLabel: store?.releaseLabel || releaseLabel,
        device,
        network,
      });
      toast.success(
        created
          ? `Created bucket · ${device} · ${network} · ${moduleName}`
          : `Opened bucket · ${device} · ${network} · ${moduleName}`,
      );
      // Same Execute UI as UAT: Pass / Run / bulk mark, with this cell locked for the board.
      const q = new URLSearchParams({ device, network });
      router.push(`/matrix/run/${selectedModule.draft.id}?${q.toString()}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setOpeningBucket(false);
    }
  };

  const loadCatalog = useCallback(async () => {
    if (projectId === null || releaseId === null) {
      setLoadError("Choose SIT, UAT, or Prod in Settings (Testing cycle) and save first.");
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
        message: `Prod Testing: loaded ${next.cases.length} Spira cases in ${catalog.modules.length} modules for ${catalog.releaseLabel}.`,
        details: {
          releaseId: catalog.releaseId,
          cases: next.cases.length,
          modules: catalog.modules.length,
          source: "matrix",
        },
      });
      toast.success(
        `Loaded ${catalog.releaseLabel} · ${plural(catalog.modules.length, "module")} · ${catalog.caseCount.toLocaleString()} cases · ${counts.android.toLocaleString()} Android · ${counts.ios.toLocaleString()} iOS`,
      );
      if (restrictToProdModules && !catalogLooksComplete(next.cases)) {
        toast.error("Still incomplete after reload — Spira did not return full iOS/Android modules. Try again or check the folder in Spira.");
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, releaseId, releaseLabel, restrictToProdModules]);

  useEffect(() => {
    autoReloadTried.current = false;
  }, [releaseId]);

  useEffect(() => {
    if (!spira?.configured || projectId === null || releaseId === null || store === null || loading) return;
    if (!store.catalogLoadedAt || releaseMismatch) {
      if (releaseMismatch && autoReloadTried.current) return;
      if (releaseMismatch) autoReloadTried.current = true;
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
  }, [spira?.configured, projectId, releaseId, store, uatDrafts.length, loading, incompleteCatalog, releaseMismatch, loadCatalog]);

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
    toast.success("Prod Testing report ready");
  };

  if (!settings || projectId === null) {
    return (
      <EmptyState icon={Grid3x3} title="Prod Testing" action={<ButtonLink href="/settings">Open Settings</ButtonLink>}>
        Save project and pick SIT, UAT, or Prod in Settings first.
      </EmptyState>
    );
  }

  const hasCatalog = !!store?.catalogLoadedAt && store.cases.length > 0 && !releaseMismatch;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Prod Testing"
        description={`Device × network buckets using Spira ${cycleLabel} cases. Switch cycle in Settings (SIT / UAT / Prod), then Reload — e.g. SIT Transfers on iOS · MTN.`}
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
      {cycle === "sit" && hasCatalog && (
        <Notice tone="info" title="Using SIT test cases">
          Settings is on <strong>{releaseLabel || "SIT"}</strong>. Open a bucket (e.g. Transfers) to run those SIT cases for the device × network you pick. Results still write to Spira on this release.
        </Notice>
      )}
      {releaseMismatch && (
        <Notice
          tone="warning"
          title="Settings release changed"
          action={
            <Button size="sm" variant="primary" icon={RefreshCw} busy={loading} onClick={() => void loadCatalog()}>
              Load {cycleLabel}
            </Button>
          }
        >
          Board still has <strong>{store?.releaseLabel || "another release"}</strong>
          {releaseLabel ? (
            <>
              ; Settings is now <strong>{releaseLabel}</strong>
            </>
          ) : null}
          . Reload to pull that cycle&apos;s modules and cases.
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
          Prod Testing only has{" "}
          <strong>
            {platforms?.android ?? 0} Android · {platforms?.ios ?? 0} iOS
          </strong>{" "}
          right now (need both platforms across ~7 modules). Click <strong>Reload full catalogue</strong>, wait for the
          toast with Android and iOS counts, then pick a module.
        </Notice>
      )}

      <Section
        title="Where are you testing?"
        description={
          hasCatalog
            ? `${store?.releaseLabel || releaseLabel} · ${platforms?.android ?? 0} Android · ${platforms?.ios ?? 0} iOS · ${plural(moduleRows.length, "module")} for ${devicePlatform}`
            : `Load Spira cases for ${cycleLabel} — every network shares that same catalogue.`
        }
      >
        {!hasCatalog ? (
          <EmptyState
            icon={Grid3x3}
            title={`Load ${cycleLabel} cases`}
            action={
              <Button icon={RefreshCw} onClick={() => void loadCatalog()} busy={loading} disabled={!spira?.configured || releaseId === null}>
                Load from Spira
              </Button>
            }
          >
            Pulls mobile modules for <strong>{releaseLabel || cycleLabel}</strong> (Android and iOS) — same device ×
            network buckets, using this cycle&apos;s test cases.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-3">
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
                Expected the 7 Prod modules: Accounts, Bill Payment, Cards, Core Banking, Onboarding, Profile, Transfers.
              </Notice>
            ) : (
              <>
                <fieldset>
                  <legend className="mb-2 text-xs font-medium text-slate-500 dark:text-zinc-500">
                    Module ({devicePlatform}) · {plural(moduleRows.length, "module")}
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
                        <span className="font-medium">{matrixModuleLabel(d.module)}</span>
                        <span className="ml-1.5 text-xs text-slate-500">{counts.total}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>

                {selectedModule && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold text-slate-900 dark:text-zinc-100">
                        {matrixModuleLabel(selectedModule.draft.module)}
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
                    <Button variant="primary" icon={Play} busy={openingBucket} onClick={openBucket}>
                      {selectedModule.executed ? "Continue bucket" : "Open bucket"}
                    </Button>
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
