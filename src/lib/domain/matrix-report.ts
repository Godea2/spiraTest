/**
 * Executive-style report for device × network matrix execution.
 * Same structure as the Spira report (status, KPIs, board, detail) — sourced from Matrix store.
 */
import {
  buildCoverage,
  environmentLabel,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  MATRIX_PACK_LABEL,
  type MatrixCellCoverage,
  type MatrixCoverage,
  type MatrixDevice,
  type MatrixNetwork,
  type MatrixResult,
  type MatrixSession,
  type MatrixStore,
} from "./matrix";
import type { ExecutionStatus } from "./types";

export type MatrixRagStatus = "green" | "amber" | "red";

export interface MatrixReportKpis {
  cells: number;
  covered: number;
  started: number;
  failedCells: number;
  notStarted: number;
  plannedRuns: number;
  executedRuns: number;
  passed: number;
  failed: number;
  blocked: number;
  caution: number;
  execPct: number | null;
  passPct: number | null;
  coveragePct: number | null;
  sessions: number;
}

export interface MatrixFailedRow {
  device: MatrixDevice;
  network: MatrixNetwork;
  testCaseId: number;
  name: string;
  module: string;
  status: ExecutionStatus;
  comment: string;
  tester: string;
  at: string;
}

export interface MatrixSessionRow {
  id: string;
  device: MatrixDevice;
  network: MatrixNetwork;
  pack: string;
  module: string | null;
  tester: string;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  updatedAt: string;
}

export interface MatrixReport {
  generatedAt: string;
  projectId: number;
  projectName: string;
  title: string;
  preparedBy: string;
  environment: string;
  releaseLabel: string;
  releaseId: number | null;
  goLive: string | null;
  status: MatrixRagStatus;
  statusReason: string;
  kpis: MatrixReportKpis;
  coverage: MatrixCoverage;
  cells: MatrixCellCoverage[];
  failures: MatrixFailedRow[];
  sessions: MatrixSessionRow[];
  summary: string;
}

export interface MatrixReportOptions {
  projectId: number;
  projectName: string;
  title?: string;
  preparedBy?: string;
  environment?: string;
  goLive?: string | null;
  releaseId?: number | null;
}

function pct(n: number, d: number): number | null {
  if (d <= 0) return null;
  return Math.round((1000 * n) / d) / 10;
}

function caseName(store: MatrixStore, caseKey: string, fallbackId: number): string {
  return store.cases.find((c) => c.key === caseKey)?.name ?? `TC${fallbackId}`;
}

function sessionRow(session: MatrixSession, results: MatrixResult[]): MatrixSessionRow {
  const byKey = new Map<string, MatrixResult>();
  for (const r of results) {
    if (r.device === session.device && r.network === session.network && r.releaseId === session.releaseId) {
      byKey.set(r.caseKey, r);
    }
  }
  let passed = 0;
  let failed = 0;
  let executed = 0;
  for (const c of session.cases) {
    const r = byKey.get(c.key);
    if (!r) continue;
    executed += 1;
    if (r.status === "passed") passed += 1;
    if (r.status === "failed") failed += 1;
  }
  return {
    id: session.id,
    device: session.device,
    network: session.network,
    pack: MATRIX_PACK_LABEL[session.pack],
    module: session.module,
    tester: session.tester,
    total: session.cases.length,
    executed,
    passed,
    failed,
    updatedAt: session.updatedAt,
  };
}

export function matrixReportStatus(coverage: MatrixCoverage, failedRuns: number): { status: MatrixRagStatus; reason: string } {
  if (coverage.failedCells > 0 || failedRuns > 0) {
    return {
      status: "red",
      reason: `${coverage.failedCells} cell${coverage.failedCells === 1 ? "" : "s"} have failures; ${failedRuns} failed run${failedRuns === 1 ? "" : "s"} on device × network.`,
    };
  }
  if (coverage.coveredCells === coverage.totalCells && coverage.totalCells > 0) {
    return { status: "green", reason: "Every device × network cell is covered with no failures." };
  }
  if (coverage.executedCells === 0) {
    return { status: "amber", reason: "Prod Testing execution has not started for this release." };
  }
  return {
    status: "amber",
    reason: `${coverage.coveredCells} of ${coverage.totalCells} cells covered; ${coverage.totalCells - coverage.executedCells} not started.`,
  };
}

/** Builds the matrix executive report from the app store (no Spira read). */
export function buildMatrixReport(store: MatrixStore, options: MatrixReportOptions): MatrixReport {
  const releaseId = options.releaseId !== undefined ? options.releaseId : store.releaseId;
  const coverage = buildCoverage(store, releaseId);
  const results = store.results.filter((r) => releaseId === null || r.releaseId === releaseId);
  const sessions = store.sessions.filter((s) => releaseId === null || s.releaseId === releaseId);

  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let caution = 0;
  for (const cell of coverage.cells) {
    passed += cell.passed;
    failed += cell.failed;
    blocked += cell.blocked;
    caution += cell.caution;
  }
  const executedRuns = coverage.cells.reduce((n, c) => n + c.executed, 0);
  const plannedRuns = coverage.cells.reduce((n, c) => n + c.planned, 0);
  const { status, reason } = matrixReportStatus(coverage, failed);

  const failures: MatrixFailedRow[] = results
    .filter((r) => r.status === "failed" || r.status === "blocked")
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((r) => ({
      device: r.device,
      network: r.network,
      testCaseId: r.testCaseId,
      name: caseName(store, r.caseKey, r.testCaseId),
      module: r.module,
      status: r.status,
      comment: r.comment,
      tester: r.tester,
      at: r.at,
    }));

  const releaseLabel = store.releaseLabel || options.environment || "Current release";
  const title = options.title?.trim() || `${options.projectName} — Device × network matrix`;

  return {
    generatedAt: new Date().toISOString(),
    projectId: options.projectId,
    projectName: options.projectName,
    title,
    preparedBy: options.preparedBy?.trim() || "",
    environment: options.environment?.trim() || releaseLabel,
    releaseLabel,
    releaseId,
    goLive: options.goLive ?? null,
    status,
    statusReason: reason,
    kpis: {
      cells: coverage.totalCells,
      covered: coverage.coveredCells,
      started: coverage.executedCells,
      failedCells: coverage.failedCells,
      notStarted: coverage.totalCells - coverage.executedCells,
      plannedRuns,
      executedRuns,
      passed,
      failed,
      blocked,
      caution,
      execPct: pct(executedRuns, plannedRuns),
      passPct: pct(passed, executedRuns),
      coveragePct: pct(coverage.coveredCells, coverage.totalCells),
      sessions: sessions.length,
    },
    coverage,
    cells: coverage.cells,
    failures,
    sessions: sessions.map((s) => sessionRow(s, results)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    summary: [
      `${coverage.coveredCells} of ${coverage.totalCells} device × network cells covered`,
      `${executedRuns.toLocaleString()} of ${(plannedRuns || 0).toLocaleString()} planned matrix runs executed`,
      failed ? `${failed} failed` : "no failures on executed runs",
    ].join(". ") + ".",
  };
}

export function matrixReportFileName(report: MatrixReport): string {
  const day = report.generatedAt.slice(0, 10);
  const release = report.releaseLabel.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40);
  return `${report.projectName} matrix ${release} ${day}`.replace(/\s+/g, " ").trim();
}

export { MATRIX_DEVICES, MATRIX_NETWORKS, environmentLabel };
