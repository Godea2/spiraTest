import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cardKey } from "@/lib/domain/board";
import { sortedEntries } from "@/lib/domain/draft-ops";
import type { Column, PreflightResult, TestSetComparison, WorkflowContext } from "@/lib/domain/types";

/**
 * Drafts live in the browser, so the server signs what it produced (comparisons and
 * passing membership checks) and only trusts data that still carries a valid signature.
 */

export class SealError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

function sealKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new SealError("SESSION_SECRET is not configured on the server.", 503);
  }
  return createHmac("sha256", secret).update("spira-reconciler/seal/v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", sealKey()).update(payload).digest("base64url");
}

function matches(seal: string | null | undefined, payload: string): boolean {
  if (!seal) return false;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(seal);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const contextPart = (ctx: WorkflowContext) => [ctx.projectId, ctx.releaseId, ctx.module];

function comparisonPayload(ctx: WorkflowContext, c: Omit<TestSetComparison, "seal">): string {
  return JSON.stringify([
    "comparison/v2",
    ...contextPart(ctx),
    c.testSetId,
    c.comparedAt,
    c.baselineMembership,
    c.cards.map((card) => [card.testSetTestCaseId, card.testCaseId, card.suggestion, card.executed]),
  ]);
}

function preflightPayload(
  ctx: WorkflowContext,
  at: string,
  testSets: TestSetComparison[],
  decisions: Record<string, Column>,
): string {
  return JSON.stringify([
    "preflight/v2",
    ...contextPart(ctx),
    at,
    [...testSets].sort((a, b) => a.testSetId - b.testSetId).map((set) => [set.testSetId, set.seal]),
    sortedEntries(decisions),
  ]);
}

export function sealComparison(ctx: WorkflowContext, comparison: Omit<TestSetComparison, "seal">): TestSetComparison {
  return { ...comparison, seal: sign(comparisonPayload(ctx, comparison)) };
}

/**
 * Returns the comparisons with card keys rebuilt from their IDs, or throws if any
 * comparison was altered or belongs to a different project, release or module.
 */
export function verifyComparisons(ctx: WorkflowContext, testSets: TestSetComparison[]): TestSetComparison[] {
  const seen = new Set<number>();
  return testSets.map((set) => {
    if (seen.has(set.testSetId)) throw new SealError(`Test set ${set.testSetId} appears twice.`);
    seen.add(set.testSetId);
    if (!matches(set.seal, comparisonPayload(ctx, set))) {
      throw new SealError(
        `The comparison for test set ${set.testSetId} could not be verified. It may be from an older version of the app or have been edited. Recompare it.`,
      );
    }
    return {
      ...set,
      cards: set.cards.map((card) => ({
        ...card,
        testSetId: set.testSetId,
        key: cardKey(set.testSetId, card.testSetTestCaseId),
      })),
    };
  });
}

export function sealPreflight(
  ctx: WorkflowContext,
  preflight: Omit<PreflightResult, "seal">,
  testSets: TestSetComparison[],
  decisions: Record<string, Column>,
): PreflightResult {
  return {
    ...preflight,
    seal: preflight.ok ? sign(preflightPayload(ctx, preflight.at, testSets, decisions)) : null,
  };
}

/** A passing check is only trusted for the exact comparisons and decisions it was run on. */
export function verifiedPreflight(
  ctx: WorkflowContext,
  preflight: PreflightResult | null | undefined,
  testSets: TestSetComparison[],
  decisions: Record<string, Column>,
): PreflightResult | null {
  if (!preflight?.ok) return null;
  return matches(preflight.seal, preflightPayload(ctx, preflight.at, testSets, decisions)) ? preflight : null;
}
