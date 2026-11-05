"use client";

import clsx from "clsx";
import { FileChartColumn, Grid3x3, Play, RefreshCw, Smartphone, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { logActivity } from "@/lib/client/activity";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  buildCoverage,
  loadMatrixStore,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  platformCounts,
  platformForDevice,
  replaceCatalog,
  type MatrixCellStatus,
  type MatrixDevice,
  type MatrixNetwork,
  type MatrixStore,
} from "@/lib/client/matrix";
import { buildMatrixReport, type MatrixReport } from "@/lib/domain/matrix-report";
import { listUatDrafts, materializeUatCatalog } from "@/lib/client/uat-build";
import { loadWeekCatalog } from "@/lib/client/week";
import { executionCards, executionCounts } from "@/lib/domain/execution";
import type { Draft } from "@/lib/domain/types";
import { StatusChip } from "../drafts/[id]/execute/runner";
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

function draftMatchesDevice(draft: Draft, device: MatrixDevice): boolean {
  const platform = platformForDevice(device);
  return draft.testSets.some((s) => s.platform === platform);
}

/**
 * Device × network coverage on top of the same Spira catalogue and Execute runner as UAT build.
 * Pick a cell, open a module, Pass/Fail like UAT — Spira is updated and the board mirrors the cell.
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
  const [loading, setLoading] = useState(false);
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

  useEffect(() => {
    if (releaseId === null) return;
    const existing = listUatDrafts(releaseId);
    if (existing.length > 0) setUatDrafts(existing);
  }, [releaseId]);

  const coverage = useMemo(() => (store ? buildCoverage(store, releaseId) : null), [store, releaseId]);
  const platforms = useMemo(() => (store ? platformCounts(store.cases) : null), [store]);
  const moduleDrafts = useMemo(
    () =>
      uatDrafts
        .filter((d) => draftMatchesDevice(d, device))
        .slice()
        .sort((a, b) => a.module.localeCompare(b.module)),
    [uatDrafts, device],
  );

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
        message: `Matrix: loaded ${next.cases.length} Spira cases for ${catalog.releaseLabel}.`,
        details: { releaseId: catalog.releaseId, cases: next.cases.length, source: "matrix" },
      });
      toast.success(
        `Loaded ${plural(counts.total, "Spira case")}: ${counts.android.toLocaleString()} Android · ${counts.ios.toLocaleString()} iOS`,
      );
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, releaseId, releaseLabel]);

  useEffect(() => {
    if (!spira?.configured || projectId === null || releaseId === null || store === null || loading) return;
    if (store.catalogLoadedAt && uatDrafts.length > 0) return;
    if (store.catalogLoadedAt && uatDrafts.length === 0) {
      // Catalogue in matrix store but UAT drafts missing — rematerialize from Spira.
      void loadCatalog();
      return;
    }
    if (!store.catalogLoadedAt) void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spira?.configured, projectId, releaseId, store, uatDrafts.length]);

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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <PageHeader
        title="Matrix"
        description="Same Spira modules and Execute runner as UAT build. Lock a device and network, open a module, Pass/Fail as usual — Spira is updated and the coverage board tracks that cell."
        actions={
          <>
            <Button
              icon={FileChartColumn}
              onClick={generateReport}
              disabled={!store?.catalogLoadedAt && !(store?.results.length)}
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
        description={
          platforms && store?.catalogLoadedAt
            ? `${releaseLabel} · ${platforms.total.toLocaleString()} Spira cases (${platforms.android.toLocaleString()} Android · ${platforms.ios.toLocaleString()} iOS) · ${coverage ? `${coverage.coveredCells} cells covered · ${coverage.executedCells} started` : ""}`
            : `${releaseLabel} · Load Spira cases (same source as UAT build)`
        }
      >
        {!coverage || (!store?.catalogLoadedAt && coverage.executedCells === 0) ? (
          <EmptyState
            icon={Smartphone}
            title="No Spira catalogue yet"
            action={
              <Button icon={RefreshCw} onClick={() => void loadCatalog()} busy={loading} disabled={!spira?.configured || releaseId === null}>
                Load Spira cases
              </Button>
            }
          >
            Pulls every iOS/Android test set on the Settings release — Accounts, Bills, Cards, Onboarding, the same modules as UAT build.
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
              Click a cell to lock device × network. Denominators are the full Spira platform catalogue (Android OEMs share Android sets).
            </p>
          </div>
        )}
      </Section>

      <Section
        title={`Execute on ${device} · ${network}`}
        description={`Same modules as UAT build for ${platformForDevice(device)}. Open a module to Pass, Fail, Block or Caution — results go to Spira and this matrix cell.`}
      >
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
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

        {moduleDrafts.length === 0 ? (
          <Notice tone="info" title="Load Spira cases to see modules">
            After load you get the same module cards as UAT build (Accounts, Bills, Cards, Onboarding, …) filtered to{" "}
            {platformForDevice(device)}.
          </Notice>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {moduleDrafts.map((d) => {
              const cards = executionCards(d);
              const counts = executionCounts(cards, d.execution);
              const executed = counts.total - counts.notRun;
              const href = `/matrix/run/${d.id}?device=${encodeURIComponent(device)}&network=${encodeURIComponent(network)}`;
              return (
                <li
                  key={d.id}
                  className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900/40"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900 dark:text-zinc-100">{d.module}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {plural(counts.total, "case")} · {executed} executed · {device} · {network}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {counts.passed > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <StatusChip status="passed" /> {counts.passed}
                      </span>
                    )}
                    {counts.failed > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <StatusChip status="failed" /> {counts.failed}
                      </span>
                    )}
                    {counts.blocked > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <StatusChip status="blocked" /> {counts.blocked}
                      </span>
                    )}
                    {counts.notRun > 0 && <Badge tone="neutral">{counts.notRun} to run</Badge>}
                  </div>
                  <ButtonLink href={href} size="sm" variant="primary" icon={Play}>
                    {executed ? "Continue" : "Run cases"}
                  </ButtonLink>
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
