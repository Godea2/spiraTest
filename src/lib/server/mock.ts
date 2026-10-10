import "server-only";
import { cardKey } from "@/lib/domain/board";
import type {
  ApplyAction,
  ApplyActionResult,
  Card,
  Column,
  MissingRow,
  MockState,
} from "@/lib/domain/types";

export interface ReconcileOutput {
  cards: Card[];
  missingFromSpira: MissingRow[];
  membership: number[];
}

const TRANSIENT_FAILURE = { testSetId: 125, testCaseId: 3661 };
const NEEDS_REVIEW_INDEXES = new Set([7, 49, 91, 133, 175]);
const SCENARIOS = [
  "Verify sign-in with valid credentials",
  "Validate error message for invalid input",
  "Confirm biometric prompt behaviour",
  "Check session timeout handling",
  "Verify navigation from the dashboard",
  "Validate push notification deep link",
  "Confirm transaction summary totals",
  "Check accessibility labels on primary actions",
  "Verify offline banner and retry",
  "Validate localisation of currency values",
];
const EXECUTION_STATUSES = ["Passed", "Failed", "Blocked", "Caution"];

export function emptyMockState(): MockState {
  return { removed: {}, transientFailureUsed: {} };
}

function fixtureShape(testSetId: number): { size: number; caseBase: number; membershipBase: number } {
  if (testSetId === 125) return { size: 211, caseBase: 3519, membershipBase: 12318 };
  const offset = Math.max(0, testSetId - 100);
  return {
    size: 24 + (testSetId % 7) * 3,
    caseBase: 5000 + offset * 300,
    membershipBase: 20000 + offset * 300,
  };
}

function prefixFor(module: string): string {
  const letters = module.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return (letters.slice(0, 3) || "MOD").padEnd(3, "X");
}

/**
 * Deterministic fixture. For test set 125 this yields 211 cards — 142 In Scope,
 * 64 Out of Scope, 5 Needs Review — with case IDs 3519–3729 and membership IDs from 12318.
 */
export function buildFixture(testSetId: number, module: string): Card[] {
  const { size, caseBase, membershipBase } = fixtureShape(testSetId);
  const prefix = prefixFor(module);
  const cards: Card[] = [];
  let outOfScope = 0;
  const outLimit = Math.round((size * 64) / 211);
  for (let i = 0; i < size; i += 1) {
    let suggestion: Column = "inScope";
    let reason = "Listed in the In-Scope sheet for this module.";
    if (NEEDS_REVIEW_INDEXES.has(i)) {
      suggestion = "needsReview";
      reason = "Listed on the Needs Confirmation sheet.";
    } else if (i % 3 === 1 && outOfScope < outLimit) {
      suggestion = "outOfScope";
      reason = "Not listed in the workbook for this module.";
      outOfScope += 1;
    }
    const executed = i % 4 === 0;
    const testCaseId = caseBase + i;
    const testSetTestCaseId = membershipBase + i;
    cards.push({
      key: cardKey(testSetId, testSetTestCaseId),
      testSetId,
      testCaseId,
      testSetTestCaseId,
      name: `${module}: ${SCENARIOS[i % SCENARIOS.length]} #${i + 1}`,
      tcId: `${prefix}-${String(i + 1).padStart(3, "0")}`,
      executionStatus: executed ? EXECUTION_STATUSES[(i / 4) % EXECUTION_STATUSES.length] : "Not Run",
      executed,
      suggestion,
      reason,
    });
  }
  return cards;
}

export function mockReconcile(state: MockState, testSetId: number, module: string): ReconcileOutput {
  const removed = new Set(state.removed[String(testSetId)] ?? []);
  const cards = buildFixture(testSetId, module).filter((card) => !removed.has(card.testSetTestCaseId));
  const prefix = prefixFor(module);
  const size = fixtureShape(testSetId).size;
  return {
    cards,
    membership: cards.map((card) => card.testSetTestCaseId),
    missingFromSpira: [1, 2].map((n) => ({
      tcId: `${prefix}-${String(size + n).padStart(3, "0")}`,
      testScenario: `${module}: workbook scenario with no matching Spira test case ${n}`,
      reason: "No test case in this test set matches this TC ID.",
    })),
  };
}

/** Returns the results and the simulated state after the batch; the input state is not modified. */
export function mockApply(
  state: MockState,
  testSetId: number,
  actions: ApplyAction[],
  dryRun: boolean,
): { results: ApplyActionResult[]; state: MockState } {
  const next: MockState = structuredClone(state);
  const key = String(testSetId);
  const removed = new Set(next.removed[key] ?? []);
  const results: ApplyActionResult[] = actions.map((action) => {
    if (removed.has(action.testSetTestCaseId)) {
      return { ...action, status: "skipped", message: "Already removed from the test set." };
    }
    if (dryRun) return { ...action, status: "wouldRemove", message: null };
    const failureKey = `${testSetId}:${action.testCaseId}`;
    const isTransient =
      testSetId === TRANSIENT_FAILURE.testSetId &&
      action.testCaseId === TRANSIENT_FAILURE.testCaseId &&
      !next.transientFailureUsed[failureKey];
    if (isTransient) {
      next.transientFailureUsed[failureKey] = true;
      return { ...action, status: "failed", message: "Simulated transient Spira error (HTTP 503). Retry should succeed." };
    }
    removed.add(action.testSetTestCaseId);
    return { ...action, status: "removed", message: null };
  });
  if (!dryRun) next.removed[key] = [...removed].sort((a, b) => a - b);
  return { results, state: next };
}
