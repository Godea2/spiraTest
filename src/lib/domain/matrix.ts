/**
 * Device × network matrix testing: app-owned execution on Spira-pulled cases.
 * Spira keeps module / iOS–Android depth; this module records compatibility cells
 * (OEM + carrier) without multiplying test sets in Spira.
 */
import type { ExecutionStatus, Platform } from "./types";

export const MATRIX_DEVICES = ["iOS", "itel", "Samsung", "tecno"] as const;
export type MatrixDevice = (typeof MATRIX_DEVICES)[number];

export const MATRIX_NETWORKS = ["MTN", "Airtel", "Glo"] as const;
export type MatrixNetwork = (typeof MATRIX_NETWORKS)[number];

/** Full Spira platform catalogue, or one Spira module (Accounts, Bills, Cards, …). */
export const MATRIX_PACKS = ["all", "module"] as const;
/** `smoke` is legacy only — old sessions may still have it; new sessions cannot start as smoke. */
export type MatrixPack = "all" | "module" | "smoke";

export const MATRIX_PACK_LABEL: Record<MatrixPack, string> = {
  all: "All Spira modules (this platform)",
  module: "One Spira module",
  smoke: "Legacy smoke (keyword subset — do not use)",
};

export type MatrixCellStatus = "notStarted" | "inProgress" | "covered" | "failed";

export interface MatrixCase {
  key: string;
  testCaseId: number;
  testSetId: number;
  testSetTestCaseId: number;
  name: string;
  module: string;
  platform: Platform;
  testSetName: string;
}

export interface MatrixResult {
  /** `${device}|${network}|${caseKey}` */
  id: string;
  caseKey: string;
  testCaseId: number;
  module: string;
  device: MatrixDevice;
  network: MatrixNetwork;
  status: ExecutionStatus;
  comment: string;
  tester: string;
  at: string;
  sessionId: string;
  releaseId: number;
}

export interface MatrixSession {
  id: string;
  projectId: number;
  releaseId: number;
  releaseLabel: string;
  device: MatrixDevice;
  network: MatrixNetwork;
  pack: MatrixPack;
  /** When pack is `module`, the module name. */
  module: string | null;
  tester: string;
  createdAt: string;
  updatedAt: string;
  cases: MatrixCase[];
}

export interface MatrixStore {
  projectId: number;
  releaseId: number | null;
  releaseLabel: string;
  catalogLoadedAt: string | null;
  /** Last Spira pull used to start sessions. */
  cases: MatrixCase[];
  sessions: MatrixSession[];
  results: MatrixResult[];
}

export interface MatrixCellCoverage {
  device: MatrixDevice;
  network: MatrixNetwork;
  status: MatrixCellStatus;
  planned: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  caution: number;
  lastAt: string | null;
  sessionIds: string[];
}

export interface MatrixCoverage {
  releaseId: number | null;
  releaseLabel: string;
  cells: MatrixCellCoverage[];
  executedCells: number;
  coveredCells: number;
  failedCells: number;
  totalCells: number;
}

export function emptyMatrixStore(projectId: number): MatrixStore {
  return {
    projectId,
    releaseId: null,
    releaseLabel: "",
    catalogLoadedAt: null,
    cases: [],
    sessions: [],
    results: [],
  };
}

export function resultId(device: MatrixDevice, network: MatrixNetwork, caseKey: string): string {
  return `${device}|${network}|${caseKey}`;
}

export function cellKey(device: MatrixDevice, network: MatrixNetwork): string {
  return `${device}|${network}`;
}

/** Which Spira platform a matrix device should run against. */
export function platformForDevice(device: MatrixDevice): Platform {
  return device === "iOS" ? "iOS" : "Android";
}

/** Cases for a new session: exact Spira cases for the device's platform (Android or iOS). */
export function selectSessionCases(
  catalog: MatrixCase[],
  input: { device: MatrixDevice; pack: MatrixPack; module: string | null },
): MatrixCase[] {
  const platform = platformForDevice(input.device);
  let list = catalog.filter((c) => c.platform === platform);
  if (input.pack === "module") {
    const want = (input.module ?? "").trim().toLowerCase();
    list = list.filter((c) => c.module.toLowerCase() === want);
  }
  return list.sort(
    (a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name) || a.testCaseId - b.testCaseId,
  );
}

/** Module roll-up for a session (same modules as Spira test-set names). */
export function modulesInSession(cases: MatrixCase[]): Array<{ module: string; count: number }> {
  const map = new Map<string, number>();
  for (const c of cases) map.set(c.module, (map.get(c.module) ?? 0) + 1);
  return [...map.entries()]
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

export function modulesInCatalog(cases: MatrixCase[]): string[] {
  return [...new Set(cases.map((c) => c.module))].sort((a, b) => a.localeCompare(b));
}

export function sessionCounts(session: MatrixSession, results: MatrixResult[]) {
  const byKey = new Map<string, MatrixResult>();
  for (const r of results) {
    if (r.device === session.device && r.network === session.network && r.releaseId === session.releaseId) {
      byKey.set(r.caseKey, r);
    }
  }
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let caution = 0;
  let executed = 0;
  for (const c of session.cases) {
    const r = byKey.get(c.key);
    if (!r) continue;
    executed += 1;
    if (r.status === "passed") passed += 1;
    else if (r.status === "failed") failed += 1;
    else if (r.status === "blocked") blocked += 1;
    else if (r.status === "caution") caution += 1;
  }
  return { total: session.cases.length, executed, passed, failed, blocked, caution, remaining: session.cases.length - executed };
}

function cellStatus(executed: number, planned: number, failed: number): MatrixCellStatus {
  if (executed === 0) return "notStarted";
  if (failed > 0) return "failed";
  if (planned > 0 && executed >= planned) return "covered";
  return "inProgress";
}

/** How many Spira cases sit on each mobile platform in the loaded catalogue. */
export function platformCounts(cases: MatrixCase[]): { android: number; ios: number; total: number } {
  let android = 0;
  let ios = 0;
  for (const c of cases) {
    if (c.platform === "Android") android += 1;
    else if (c.platform === "iOS") ios += 1;
  }
  return { android, ios, total: cases.length };
}

/**
 * Coverage grid for a release. Planned = every Spira case on that device's platform
 * (Samsung/itel/tecno → Android sets; iOS → iOS sets) — the same catalogue used across networks.
 */
export function buildCoverage(
  store: MatrixStore,
  releaseId: number | null = store.releaseId,
): MatrixCoverage {
  const cases = store.cases;
  const results = store.results.filter((r) => releaseId === null || r.releaseId === releaseId);
  const sessions = store.sessions.filter((s) => releaseId === null || s.releaseId === releaseId);

  const cells: MatrixCellCoverage[] = [];
  for (const device of MATRIX_DEVICES) {
    const platform = platformForDevice(device);
    const platformPlanned = cases.filter((c) => c.platform === platform).length;
    for (const network of MATRIX_NETWORKS) {
      const cellResults = results.filter((r) => r.device === device && r.network === network);
      const byCase = new Map<string, MatrixResult>();
      for (const r of cellResults) byCase.set(r.caseKey, r);
      let passed = 0;
      let failed = 0;
      let blocked = 0;
      let caution = 0;
      let lastAt: string | null = null;
      for (const r of byCase.values()) {
        if (r.status === "passed") passed += 1;
        else if (r.status === "failed") failed += 1;
        else if (r.status === "blocked") blocked += 1;
        else if (r.status === "caution") caution += 1;
        if (!lastAt || r.at > lastAt) lastAt = r.at;
      }
      const executed = byCase.size;
      const sessionIds = [...new Set(sessions.filter((s) => s.device === device && s.network === network).map((s) => s.id))];
      // Planned is the Spira platform catalogue; a session may run a subset (smoke/module).
      const sessionPlanned = Math.max(0, ...sessions.filter((s) => s.device === device && s.network === network).map((s) => s.cases.length), 0);
      const planned = Math.max(platformPlanned, sessionPlanned, executed);
      cells.push({
        device,
        network,
        status: cellStatus(executed, planned, failed),
        planned,
        executed,
        passed,
        failed,
        blocked,
        caution,
        lastAt,
        sessionIds,
      });
    }
  }

  return {
    releaseId,
    releaseLabel: store.releaseLabel,
    cells,
    executedCells: cells.filter((c) => c.executed > 0).length,
    coveredCells: cells.filter((c) => c.status === "covered").length,
    failedCells: cells.filter((c) => c.status === "failed").length,
    totalCells: cells.length,
  };
}

export function upsertResult(store: MatrixStore, result: MatrixResult): MatrixStore {
  const results = store.results.filter((r) => r.id !== result.id);
  results.push(result);
  results.sort((a, b) => b.at.localeCompare(a.at));
  return { ...store, results: results.slice(0, 8_000) };
}

export function clearCellResults(
  store: MatrixStore,
  device: MatrixDevice,
  network: MatrixNetwork,
  releaseId: number,
): MatrixStore {
  return {
    ...store,
    results: store.results.filter(
      (r) => !(r.device === device && r.network === network && r.releaseId === releaseId),
    ),
  };
}

export function environmentLabel(device: MatrixDevice, network: MatrixNetwork): string {
  return `${device} · ${network}`;
}
