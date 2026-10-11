import { z } from "zod";
import { effectiveColumn, moveCards } from "./board";
import { COLUMNS, type BlockedAssessment, type Card, type CardChange, type Column } from "./types";

export const MAX_KEYWORDS = 50;
export const MAX_SCENARIO_TEXT = 1000;
/** Cases sent to the AI review per request. */
export const MAX_AI_REVIEW_BATCH = 20;

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

/**
 * The test scenario only: the Spira test case name and the workbook's Test Scenario.
 * Steps and test data are deliberately left out; mentioning a feature there does not mean the case depends on it.
 */
export function scenarioText(card: Card): string {
  return [card.name, card.workbookScenario ?? ""].filter(Boolean).join("\n");
}

export function keywordsFor(byTestSet: TestSetKeywordMap | undefined, testSetId: number): string[] {
  return byTestSet?.[String(testSetId)] ?? [];
}

export function hasKeywords(byTestSet: TestSetKeywordMap | undefined): boolean {
  return Object.values(byTestSet ?? {}).some((list) => list.length > 0);
}

/** Matching keywords for every card whose scenario mentions at least one keyword of its own test set. */
export function keywordHits(cards: Card[], byTestSet: TestSetKeywordMap | undefined): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  if (!hasKeywords(byTestSet)) return hits;
  for (const card of cards) {
    const found = matchKeywords(scenarioText(card), keywordsFor(byTestSet, card.testSetId));
    if (found.length) hits.set(card.key, found);
  }
  return hits;
}

export interface KeywordReportRow {
  testSetId: number;
  keyword: string;
  /** Cards whose scenario mentions the keyword, by the column they are in now. */
  byColumn: Record<Column, Card[]>;
}

/** For each test set and keyword, which cards mention it and where they sit on the board. */
export function keywordReport(
  cards: Card[],
  decisions: Record<string, Column>,
  byTestSet: TestSetKeywordMap | undefined,
): KeywordReportRow[] {
  const hits = keywordHits(cards, byTestSet);
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

/** A case whose scenario mentions a keyword and that is In Scope or Blocked, so it needs a blocked/not-blocked decision. */
export interface BlockedCandidate {
  card: Card;
  keywords: string[];
}

export function blockedCandidates(
  cards: Card[],
  decisions: Record<string, Column>,
  byTestSet: TestSetKeywordMap | undefined,
): BlockedCandidate[] {
  const hits = keywordHits(cards, byTestSet);
  return cards
    .filter((card) => hits.has(card.key) && ["inScope", "blocked"].includes(effectiveColumn(card, decisions)))
    .map((card) => ({ card, keywords: hits.get(card.key)! }));
}

/**
 * In Scope or Blocked cards, in test sets with keywords, whose scenario names none of them. Only the AI deep check
 * looks at these, for scenarios that describe a missing feature in other words.
 */
export function deepCandidates(
  cards: Card[],
  decisions: Record<string, Column>,
  byTestSet: TestSetKeywordMap | undefined,
): BlockedCandidate[] {
  const hits = keywordHits(cards, byTestSet);
  return cards
    .filter(
      (card) =>
        keywordsFor(byTestSet, card.testSetId).length > 0 &&
        !hits.has(card.key) &&
        ["inScope", "blocked"].includes(effectiveColumn(card, decisions)),
    )
    .map((card) => ({ card, keywords: [] }));
}

/** The verdict used when no AI review is available: a keyword in the scenario means Blocked. */
export function keywordAssessment(keywords: string[], at: string): BlockedAssessment {
  return {
    keywords,
    blocked: true,
    confidence: null,
    reason: `The test scenario mentions ${keywords.join(", ")}.`,
    source: "keyword",
    at,
  };
}

const sameKeywords = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));

/** True when the saved verdict came from the AI and covers exactly the keywords the scenario mentions now. */
export function hasCurrentAiVerdict(assessment: BlockedAssessment | undefined, keywords: string[]): boolean {
  return !!assessment && assessment.source === "ai" && sameKeywords(assessment.keywords, keywords);
}

/** True when a deep-check verdict exists and was made against the test set's current keyword list. */
export function hasCurrentDeepVerdict(assessment: BlockedAssessment | undefined, setKeywords: string[]): assessment is BlockedAssessment {
  return !!assessment && assessment.source === "ai" && assessment.keywords.length === 0 && !!assessment.against && sameKeywords(assessment.against, setKeywords);
}

/** match: the scenario names a keyword. deep: it does not, but the AI deep check found a dependency (or cleared a Blocked card). */
export type ProposalKind = "match" | "noKeyword" | "deep";

export interface BlockedProposal {
  card: Card;
  current: Column;
  proposed: "blocked" | "inScope";
  kind: ProposalKind;
  keywords: string[];
  /** Null when the case has not been analysed for its current keywords yet. */
  assessment: BlockedAssessment | null;
}

/**
 * What the review suggests for each relevant card:
 * - In Scope or Blocked cards whose scenario mentions a keyword go where their assessment says.
 * - Blocked cards in a test set with keywords whose scenario mentions none of them are offered back to In Scope.
 */
export function blockedProposals(
  cards: Card[],
  decisions: Record<string, Column>,
  byTestSet: TestSetKeywordMap | undefined,
  review: Record<string, BlockedAssessment> | undefined,
): BlockedProposal[] {
  const hits = keywordHits(cards, byTestSet);
  const proposals: BlockedProposal[] = [];
  for (const card of cards) {
    const setKeywords = keywordsFor(byTestSet, card.testSetId);
    if (setKeywords.length === 0) continue;
    const current = effectiveColumn(card, decisions);
    if (current !== "inScope" && current !== "blocked") continue;
    const keywords = hits.get(card.key);
    const saved = review?.[card.key];
    if (keywords) {
      const assessment = saved && sameKeywords(saved.keywords, keywords) ? saved : null;
      proposals.push({ card, current, proposed: assessment && !assessment.blocked ? "inScope" : "blocked", kind: "match", keywords, assessment });
    } else if (hasCurrentDeepVerdict(saved, setKeywords)) {
      if (saved.blocked || current === "blocked") {
        proposals.push({ card, current, proposed: saved.blocked ? "blocked" : "inScope", kind: "deep", keywords: [], assessment: saved });
      }
    } else if (current === "blocked") {
      proposals.push({ card, current, proposed: "inScope", kind: "noKeyword", keywords: [], assessment: null });
    }
  }
  return proposals;
}

/** Proposals selected by default: analysed changes the reviewer is likely to accept. Low-confidence AI answers are left for a person. */
export function defaultSelection(proposals: BlockedProposal[]): Set<string> {
  return new Set(
    proposals
      .filter((p) => p.kind !== "noKeyword" && p.assessment && p.proposed !== p.current && p.assessment.confidence !== "low")
      .map((p) => p.card.key),
  );
}

/** Applies the chosen proposals: each selected card moves to its proposed column. */
export function applyProposals(
  cards: Card[],
  decisions: Record<string, Column>,
  proposals: BlockedProposal[],
  selected: Set<string>,
): { decisions: Record<string, Column>; changes: CardChange[] } {
  const chosen = proposals.filter((p) => selected.has(p.card.key) && p.proposed !== p.current);
  const toBlocked = moveCards(cards, decisions, chosen.filter((p) => p.proposed === "blocked").map((p) => p.card.key), "blocked");
  const toInScope = moveCards(cards, toBlocked.decisions, chosen.filter((p) => p.proposed === "inScope").map((p) => p.card.key), "inScope");
  return { decisions: toInScope.decisions, changes: [...toBlocked.changes, ...toInScope.changes] };
}
