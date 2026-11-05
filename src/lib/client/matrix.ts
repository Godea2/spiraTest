/**
 * Browser store for device × network matrix sessions and results (synced via shared store).
 */
import {
  buildCoverage,
  emptyMatrixStore,
  environmentLabel,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  MATRIX_PACK_LABEL,
  MATRIX_PACKS,
  modulesInCatalog,
  modulesInSession,
  platformCounts,
  platformForDevice,
  resultId,
  selectSessionCases,
  sessionCounts,
  upsertResult,
  type MatrixCase,
  type MatrixCellStatus,
  type MatrixDevice,
  type MatrixNetwork,
  type MatrixPack,
  type MatrixResult,
  type MatrixSession,
  type MatrixStore,
} from "@/lib/domain/matrix";
import type { ExecutionStatus, Platform } from "@/lib/domain/types";
import { logActivity } from "./activity";
import { readItem, writeItem } from "./storage";
import type { WeekCatalog } from "./week";

const storeKey = (projectId: number) => `matrix:${projectId}`;

export function loadMatrixStore(projectId: number): MatrixStore {
  const stored = readItem<MatrixStore>(storeKey(projectId));
  if (!stored || stored.projectId !== projectId) return emptyMatrixStore(projectId);
  return {
    ...emptyMatrixStore(projectId),
    ...stored,
    cases: stored.cases ?? [],
    sessions: stored.sessions ?? [],
    results: stored.results ?? [],
  };
}

export function saveMatrixStore(store: MatrixStore): void {
  writeItem(storeKey(store.projectId), store);
}

/** Flatten a week catalog into matrix cases (one row per Spira set membership). */
export function casesFromWeekCatalog(catalog: WeekCatalog): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const mod of catalog.modules) {
    for (const set of mod.testSets) {
      for (const card of set.cards) {
        out.push({
          key: card.key,
          testCaseId: card.testCaseId,
          testSetId: card.testSetId,
          testSetTestCaseId: card.testSetTestCaseId,
          name: card.name,
          module: mod.module,
          platform: set.platform as Platform,
          testSetName: set.testSetName,
        });
      }
    }
  }
  return out;
}

export function replaceCatalog(
  projectId: number,
  catalog: WeekCatalog,
): MatrixStore {
  const prev = loadMatrixStore(projectId);
  const next: MatrixStore = {
    ...prev,
    projectId,
    releaseId: catalog.releaseId,
    releaseLabel: catalog.releaseLabel,
    catalogLoadedAt: new Date().toISOString(),
    cases: casesFromWeekCatalog(catalog),
  };
  saveMatrixStore(next);
  logActivity({
    type: "matrix.catalogLoaded",
    message: `Matrix: loaded ${next.cases.length} Spira cases for ${catalog.releaseLabel}.`,
    details: { releaseId: catalog.releaseId, cases: next.cases.length },
  });
  return next;
}

function newSessionId(): string {
  return `mx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function startMatrixSession(input: {
  projectId: number;
  device: MatrixDevice;
  network: MatrixNetwork;
  pack: MatrixPack;
  module: string | null;
  tester: string;
}): { store: MatrixStore; session: MatrixSession } {
  const store = loadMatrixStore(input.projectId);
  if (!store.releaseId || store.cases.length === 0) {
    throw new Error("Load the Spira case catalogue for this release before starting a session.");
  }
  const cases = selectSessionCases(store.cases, {
    device: input.device,
    pack: input.pack,
    module: input.module,
  });
  if (cases.length === 0) {
    throw new Error(
      input.pack === "module"
        ? `No Spira cases in module "${input.module}" for ${input.device}. Reload cases or pick another module.`
        : `No Spira ${platformForDevice(input.device)} cases on this release. Reload cases from Settings release 1.0.0.0.0006.`,
    );
  }
  const now = new Date().toISOString();
  const session: MatrixSession = {
    id: newSessionId(),
    projectId: input.projectId,
    releaseId: store.releaseId,
    releaseLabel: store.releaseLabel,
    device: input.device,
    network: input.network,
    pack: input.pack,
    module: input.pack === "module" ? input.module : null,
    tester: input.tester.trim(),
    createdAt: now,
    updatedAt: now,
    cases,
  };
  const sessions = [session, ...store.sessions.filter((s) => s.id !== session.id)].slice(0, 80);
  const next = { ...store, sessions };
  saveMatrixStore(next);
  logActivity({
    type: "matrix.sessionStarted",
    message: `Matrix session ${environmentLabel(session.device, session.network)}: ${cases.length} case(s) (${session.pack}).`,
    details: {
      sessionId: session.id,
      device: session.device,
      network: session.network,
      pack: session.pack,
      cases: cases.length,
    },
  });
  return { store: next, session };
}

export function getMatrixSession(projectId: number, sessionId: string): MatrixSession | null {
  return loadMatrixStore(projectId).sessions.find((s) => s.id === sessionId) ?? null;
}

export function recordMatrixResult(input: {
  projectId: number;
  sessionId: string;
  caseKey: string;
  status: ExecutionStatus;
  comment: string;
  tester: string;
}): MatrixStore {
  const store = loadMatrixStore(input.projectId);
  const session = store.sessions.find((s) => s.id === input.sessionId);
  if (!session) throw new Error("That matrix session was not found.");
  const card = session.cases.find((c) => c.key === input.caseKey);
  if (!card) throw new Error("That case is not in this session.");
  const now = new Date().toISOString();
  const result: MatrixResult = {
    id: resultId(session.device, session.network, card.key),
    caseKey: card.key,
    testCaseId: card.testCaseId,
    module: card.module,
    device: session.device,
    network: session.network,
    status: input.status,
    comment: input.comment.trim().slice(0, 2_000),
    tester: input.tester.trim().slice(0, 100),
    at: now,
    sessionId: session.id,
    releaseId: session.releaseId,
  };
  const sessions = store.sessions.map((s) => (s.id === session.id ? { ...s, updatedAt: now, tester: result.tester || s.tester } : s));
  const next = upsertResult({ ...store, sessions }, result);
  saveMatrixStore(next);
  return next;
}

export function clearMatrixResult(projectId: number, sessionId: string, caseKey: string): MatrixStore {
  const store = loadMatrixStore(projectId);
  const session = store.sessions.find((s) => s.id === sessionId);
  if (!session) return store;
  const id = resultId(session.device, session.network, caseKey);
  const next = { ...store, results: store.results.filter((r) => r.id !== id) };
  saveMatrixStore(next);
  return next;
}

export function deleteMatrixSession(projectId: number, sessionId: string): MatrixStore {
  const store = loadMatrixStore(projectId);
  const next = {
    ...store,
    sessions: store.sessions.filter((s) => s.id !== sessionId),
  };
  saveMatrixStore(next);
  return next;
}

export function matrixCoverageFor(projectId: number, releaseId?: number | null) {
  const store = loadMatrixStore(projectId);
  return buildCoverage(store, releaseId === undefined ? store.releaseId : releaseId);
}

export function resultsForSession(store: MatrixStore, session: MatrixSession): Map<string, MatrixResult> {
  const map = new Map<string, MatrixResult>();
  for (const r of store.results) {
    if (r.device === session.device && r.network === session.network && r.releaseId === session.releaseId) {
      map.set(r.caseKey, r);
    }
  }
  return map;
}

export {
  buildCoverage,
  environmentLabel,
  MATRIX_DEVICES,
  MATRIX_NETWORKS,
  MATRIX_PACK_LABEL,
  MATRIX_PACKS,
  modulesInCatalog,
  modulesInSession,
  platformCounts,
  platformForDevice,
  selectSessionCases,
  sessionCounts,
};
export type {
  MatrixCase,
  MatrixCellStatus,
  MatrixDevice,
  MatrixNetwork,
  MatrixPack,
  MatrixResult,
  MatrixSession,
  MatrixStore,
};
