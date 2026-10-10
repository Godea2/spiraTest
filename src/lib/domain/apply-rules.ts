import { allCards, effectiveColumn, MAX_APPLY_BATCH } from "./board";
import { COLUMN_LABELS, type ApplyAction, type Column, type PreflightResult, type SignOffStatus, type TestSetComparison } from "./types";

/** Column a card must be in to record each result. */
export const SIGN_OFF_COLUMN: Record<SignOffStatus, Column> = { blocked: "blocked", passed: "inScope" };

export const PREFLIGHT_MAX_AGE_MS = 15 * 60 * 1000;

export class ApplyValidationError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface ApplyBatchInput {
  testSetId: number;
  dryRun: boolean;
  confirmModule?: string;
  actions: ApplyAction[];
}

export interface ApplyBoard {
  module: string;
  testSets: TestSetComparison[];
  decisions: Record<string, Column>;
  /** Must already be verified by the server; anything unverified counts as no check. */
  preflight: PreflightResult | null;
}

/**
 * Batched apply. Every action must correspond to a card that is currently in `column`
 * on the board (manually moved or suggested): Out of Scope for removals, Blocked or
 * In Scope when recording results.
 */
export function validateApplyBatch(
  board: ApplyBoard,
  input: ApplyBatchInput,
  now = Date.now(),
  column: Column = "outOfScope",
): void {
  if (input.actions.length === 0) throw new ApplyValidationError("No actions to apply.");
  if (input.actions.length > MAX_APPLY_BATCH) {
    throw new ApplyValidationError(`Send at most ${MAX_APPLY_BATCH} actions per batch.`);
  }
  const set = board.testSets.find((s) => s.testSetId === input.testSetId);
  if (!set) throw new ApplyValidationError(`Test set ${input.testSetId} is not part of this draft.`);

  const inColumn = new Map(
    set.cards
      .filter((card) => effectiveColumn(card, board.decisions) === column)
      .map((card) => [card.testSetTestCaseId, card]),
  );
  const seen = new Set<number>();
  for (const action of input.actions) {
    if (seen.has(action.testSetTestCaseId)) {
      throw new ApplyValidationError(`Membership ${action.testSetTestCaseId} appears twice in this batch.`);
    }
    seen.add(action.testSetTestCaseId);
    const card = inColumn.get(action.testSetTestCaseId);
    if (!card || card.testCaseId !== action.testCaseId) {
      throw new ApplyValidationError(
        `Case ${action.testCaseId} (membership ${action.testSetTestCaseId}) is not a ${COLUMN_LABELS[column]} card in this draft. Only saved ${COLUMN_LABELS[column]} cards can be used here.`,
      );
    }
  }

  if (input.dryRun) return;

  if (input.confirmModule !== board.module.toUpperCase()) {
    throw new ApplyValidationError(`Type ${board.module.toUpperCase()} exactly to confirm a live apply.`);
  }
  const needsReview = allCards(board.testSets).filter(
    (card) => effectiveColumn(card, board.decisions) === "needsReview",
  ).length;
  if (needsReview > 0) {
    throw new ApplyValidationError(`Resolve the ${needsReview} Needs Review card(s) before a live apply.`);
  }
  const preflight = board.preflight;
  if (!preflight || !preflight.ok) {
    throw new ApplyValidationError("Run the membership check first; live apply is blocked until it passes.", 409);
  }
  if (now - Date.parse(preflight.at) > PREFLIGHT_MAX_AGE_MS) {
    throw new ApplyValidationError("The membership check is more than 15 minutes old. Run it again.", 409);
  }
}
