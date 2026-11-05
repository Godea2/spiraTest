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

export const MATRIX_PACKS = ["smoke", "module", "all"] as const;
export type MatrixPack = (typeof MATRIX_PACKS)[number];

export const MATRIX_PACK_LABEL: Record<MatrixPack, string> = {
  smoke: "Carrier / device smoke",
  module: "Full module",
  all: "All cases on release",
};

/** Journeys that are sensitive to SIM, OTP, airtime, and OEM quirks. */
export const SMOKE_KEYWORDS = [
  "login",
  "sign in",
  "signin",
  "otp",
  "pin",
  "onboard",
  "registration",
  "register",
  "transfer",
  "send money",
  "airtime",
  "top-up",
  "top up",
  "topup",
  "recharge",
  "data",
  "bill",
  "payment",
  "pay ",
  "network",
  "ussd",
  "sim",
  "wallet",
  "balance",
  "home",
  "dashboard",
] as const;

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

export function isSmokeCase(name: string): boolean {
  const text = name.toLowerCase();
  return SMOKE_KEYWORDS.some((k) => text.includes(k));
}

/** Cases for a new session: device platform + pack filter. */
export function selectSessionCases(
  catalog: MatrixCase[],
  input: { device: MatrixDevice; pack: MatrixPack; module: string | null },
): MatrixCase[] {
  const platform = platformForDevice(input.device);
  let list = catalog.filter((c) => c.platform === platform);
  if (input.pack === "smoke") list = list.filter((c) => isSmokeCase(c.name));
  if (input.pack === "module") {
    const want = (input.module ?? "").trim().toLowerCase();
    list = list.filter((c) => c.module.toLowerCase() === want);
  }
  return list.sort(
    (a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name) || a.testCaseId - b.testCaseId,
  );
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

/**
 * Coverage grid for a release. Planned count prefers smoke cases for that device's platform
 * (what we expect every cell to hit); executed comes from stored matrix results.
 */
export function buildCoverage(
  store: MatrixStore,
  releaseId: number | null = store.releaseId,
): MatrixCoverage {
  const cases = releaseId === null || store.releaseId === releaseId ? store.cases : store.cases;
  const results = store.results.filter((r) => releaseId === null || r.releaseId === releaseId);
  const sessions = store.sessions.filter((s) => releaseId === null || s.releaseId === releaseId);

  const cells: MatrixCellCoverage[] = [];
  for (const device of MATRIX_DEVICES) {
    const platform = platformForDevice(device);
    const smokePlanned = cases.filter((c) => c.platform === platform && isSmokeCase(c.name)).length;
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
      // If a session ran a larger pack, planned is at least what was executed or smoke size.
      const sessionPlanned = Math.max(0, ...sessions.filter((s) => s.device === device && s.network === network).map((s) => s.cases.length), 0);
      const planned = Math.max(smokePlanned, sessionPlanned, executed);
      cells.push({
        device,
        network,
        status: cellStatus(executed, planned > 0 ? planned : smokePlanned, failed),
        planned: planned || smokePlanned,
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
