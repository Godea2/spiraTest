import { z } from "zod";
import { effectiveColumn, moveCards } from "./board";
import type { Card, CardChange, Column, Draft } from "./types";

export const MAX_KEYWORDS = 50;
export const MAX_STEP_TEXT = 6000;

export const keywordListSchema = z.array(z.string().trim().max(60)).max(MAX_KEYWORDS);

/** Trims, drops blanks and removes case-insensitive duplicates, keeping the first spelling. */
export function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const keyword = raw.trim().replace(/\s+/g, " ");
    const id = keyword.toLowerCase();
    if (!keyword || seen.has(id)) continue;
    seen.add(id);
    out.push(keyword);
  }
  return out.slice(0, MAX_KEYWORDS);
}

/** Splits text typed into a keyword box: commas, semicolons or new lines separate keywords. */
export function parseKeywords(text: string): string[] {
  return normalizeKeywords(text.split(/[,;\n]+/));
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** Spira stores descriptions and steps as HTML; this keeps only the words. */
export function plainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (_, name: string) => ENTITIES[name.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordPattern(keyword: string): RegExp {
  const body = keyword
    .split(" ")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Keywords found in the text as whole words, case-insensitive: "nin" matches "Verify NIN"
 * and "nin-based" but not "running".
 */
export function matchKeywords(text: string, keywords: string[]): string[] {
  if (!text) return [];
  return keywords.filter((keyword) => keywordPattern(keyword).test(text));
}

export function cardSearchText(card: Card, stepText: Record<string, string> | undefined): string {
  return [card.name, card.description ?? "", stepText?.[String(card.testCaseId)] ?? ""].join("\n");
}

/** Keywords for every test set, plus extra keywords for single test sets keyed by test set ID. */
export interface KeywordScope {
  all: string[];
  byTestSet?: Record<string, string[]>;
}

export function draftKeywords(draft: Pick<Draft, "keywords" | "testSetKeywords">): KeywordScope {
  return { all: draft.keywords ?? [], byTestSet: draft.testSetKeywords ?? {} };
}

export function keywordsFor(scope: KeywordScope, testSetId: number): string[] {
  return normalizeKeywords([...scope.all, ...(scope.byTestSet?.[String(testSetId)] ?? [])]);
}

export function hasKeywords(scope: KeywordScope): boolean {
  return scope.all.length > 0 || Object.values(scope.byTestSet ?? {}).some((list) => list.length > 0);
}

/** Matching keywords for every card that mentions at least one of the keywords for its test set. */
export function keywordHits(
  cards: Card[],
  scope: KeywordScope,
  stepText: Record<string, string> | undefined,
): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  if (!hasKeywords(scope)) return hits;
  const perSet = new Map<number, string[]>();
  for (const card of cards) {
    if (!perSet.has(card.testSetId)) perSet.set(card.testSetId, keywordsFor(scope, card.testSetId));
    const found = matchKeywords(cardSearchText(card, stepText), perSet.get(card.testSetId)!);
    if (found.length) hits.set(card.key, found);
  }
  return hits;
}

/** Moves In Scope cards that mention a keyword to Blocked. Other columns are left alone. */
export function blockMatchingCards(
  cards: Card[],
  decisions: Record<string, Column>,
  scope: KeywordScope,
  stepText: Record<string, string> | undefined,
): { decisions: Record<string, Column>; changes: CardChange[]; hits: Map<string, string[]> } {
  const hits = keywordHits(cards, scope, stepText);
  const keys = cards
    .filter((card) => hits.has(card.key) && effectiveColumn(card, decisions) === "inScope")
    .map((card) => card.key);
  return { ...moveCards(cards, decisions, keys, "blocked"), hits };
}

export const testSetKeywordsSchema = z
  .array(
    z.object({
      testSetId: z.number().int().positive(),
      testSetName: z.string().trim().max(200),
      keywords: keywordListSchema,
    }),
  )
  .max(200);
