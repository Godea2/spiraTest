import { z } from "zod";
import { effectiveColumn, moveCards } from "./board";
import { COLUMNS, type Card, type CardChange, type Column } from "./types";

export const MAX_KEYWORDS = 50;
export const MAX_STEP_TEXT = 6000;

export const keywordListSchema = z.array(z.string().trim().max(60)).max(MAX_KEYWORDS);

/** Not-implemented keywords per test set, keyed by test set ID. */
export type TestSetKeywordMap = Record<string, string[]>;

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

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntity(entity: string): string {
  if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(parseInt(entity.slice(2), 16) || 32);
  if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)) || 32);
  return ENTITIES[entity.toLowerCase()] ?? " ";
}

/** Spira stores descriptions and steps as HTML; this keeps only the words. */
export function plainText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => decodeEntity(entity))
    .replace(/\s+/g, " ")
    .trim();
}

function keywordPattern(keyword: string): RegExp {
  const body = keyword
    .split(" ")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:'?s)?(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * Keywords found in the text as whole words, ignoring case, with an optional plural "s":
 * "nin" matches "Verify NIN", "NINs" and "BVN/NIN" but not "running".
 */
export function matchKeywords(text: string, keywords: string[]): string[] {
  if (!text) return [];
  return keywords.filter((keyword) => keywordPattern(keyword).test(text));
}

/** Everything known about a case: Spira name, description and custom fields, its steps, and the matched workbook row. */
export function cardSearchText(card: Card, stepText: Record<string, string> | undefined): string {
  return [card.name, card.description ?? "", stepText?.[String(card.testCaseId)] ?? "", card.workbookText ?? ""].join("\n");
}

export function keywordsFor(byTestSet: TestSetKeywordMap | undefined, testSetId: number): string[] {
  return byTestSet?.[String(testSetId)] ?? [];
}

export function hasKeywords(byTestSet: TestSetKeywordMap | undefined): boolean {
  return Object.values(byTestSet ?? {}).some((list) => list.length > 0);
}

/** Matching keywords for every card that mentions at least one keyword of its own test set. */
export function keywordHits(
  cards: Card[],
  byTestSet: TestSetKeywordMap | undefined,
  stepText: Record<string, string> | undefined,
): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  if (!hasKeywords(byTestSet)) return hits;
  for (const card of cards) {
    const found = matchKeywords(cardSearchText(card, stepText), keywordsFor(byTestSet, card.testSetId));
    if (found.length) hits.set(card.key, found);
  }
  return hits;
}

/** Moves In Scope cards that mention a keyword to Blocked. Other columns are left alone. */
export function blockMatchingCards(
  cards: Card[],
  decisions: Record<string, Column>,
  byTestSet: TestSetKeywordMap | undefined,
  stepText: Record<string, string> | undefined,
): { decisions: Record<string, Column>; changes: CardChange[]; hits: Map<string, string[]> } {
  const hits = keywordHits(cards, byTestSet, stepText);
  const keys = cards
    .filter((card) => hits.has(card.key) && effectiveColumn(card, decisions) === "inScope")
    .map((card) => card.key);
  return { ...moveCards(cards, decisions, keys, "blocked"), hits };
}

export interface KeywordReportRow {
  testSetId: number;
  keyword: string;
  /** Cards that mention the keyword, by the column they are in now. */
  byColumn: Record<Column, Card[]>;
}

/** For each test set and keyword, which cards mention it and where they sit on the board. */
export function keywordReport(
  cards: Card[],
  decisions: Record<string, Column>,
  byTestSet: TestSetKeywordMap | undefined,
  stepText: Record<string, string> | undefined,
): KeywordReportRow[] {
  const hits = keywordHits(cards, byTestSet, stepText);
  const rows: KeywordReportRow[] = [];
  for (const [setId, keywords] of Object.entries(byTestSet ?? {})) {
    for (const keyword of keywords) {
      const byColumn = Object.fromEntries(COLUMNS.map((c) => [c, [] as Card[]])) as Record<Column, Card[]>;
      for (const card of cards) {
        if (String(card.testSetId) === setId && hits.get(card.key)?.includes(keyword)) {
          byColumn[effectiveColumn(card, decisions)].push(card);
        }
      }
      rows.push({ testSetId: Number(setId), keyword, byColumn });
    }
  }
  return rows;
}
