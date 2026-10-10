import { allCards, effectiveColumn, MAX_APPLY_BATCH } from "./board";
import type { ApplyAction, Column, PreflightResult, TestSetComparison } from "./types";

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
 * Remove-only, batched apply. Every action must correspond to a card that is
 * currently Out of Scope on the board (manually moved or suggested).
 */
export function validateApplyBatch(board: ApplyBoard, input: ApplyBatchInput, now = Date.now()): void {
  if (input.actions.length === 0) throw new ApplyValidationError("No actions to apply.");
  if (input.actions.length > MAX_APPLY_BATCH) {
    throw new ApplyValidationError(`Send at most ${MAX_APPLY_BATCH} actions per batch.`);
  }
  const set = board.testSets.find((s) => s.testSetId === input.testSetId);
  if (!set) throw new ApplyValidationError(`Test set ${input.testSetId} is not part of this draft.`);

  const outOfScope = new Map(
    set.cards
      .filter((card) => effectiveColumn(card, board.decisions) === "outOfScope")
      .map((card) => [card.testSetTestCaseId, card]),
  );
  const seen = new Set<number>();
  for (const action of input.actions) {
    if (seen.has(action.testSetTestCaseId)) {
      throw new ApplyValidationError(`Membership ${action.testSetTestCaseId} appears twice in this batch.`);
    }
    seen.add(action.testSetTestCaseId);
    const card = outOfScope.get(action.testSetTestCaseId);
    if (!card || card.testCaseId !== action.testCaseId) {
      throw new ApplyValidationError(
        `Case ${action.testCaseId} (membership ${action.testSetTestCaseId}) is not an Out of Scope card in this draft. Only saved Out of Scope cards can be removed.`,
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
