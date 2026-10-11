export const COLUMNS = ["inScope", "blocked", "outOfScope", "needsReview"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  inScope: "In Scope",
  blocked: "Blocked",
  outOfScope: "Out of Scope",
  needsReview: "Needs Review",
};

/** Results the app records in Spira on sign-off. */
export const SIGN_OFF_STATUSES = ["blocked", "passed"] as const;
export type SignOffStatus = (typeof SIGN_OFF_STATUSES)[number];

export const PLATFORMS = ["Android", "iOS", "Web", "Other"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type CellValue = string | number | boolean | null;

export type WorkbookScope = "inScope" | "needsConfirmation";

export interface WorkbookRow {
  sheet: string;
  rowNumber: number;
  scope: WorkbookScope;
  values: Record<string, CellValue>;
}

export interface Card {
  /** `${testSetId}:${testSetTestCaseId}` — unique across a draft. */
  key: string;
  testSetId: number;
  testCaseId: number;
  testSetTestCaseId: number;
  name: string;
  tcId: string | null;
  executionStatus: string;
  executed: boolean;
  suggestion: Column;
  reason: string;
  /** Test Scenario of the matched workbook row; with the name, the text checked for not-implemented keywords. */
  workbookScenario?: string;
}

export type BlockedConfidence = "high" | "medium" | "low";

/** Whether a case whose scenario mentions a not-implemented keyword really depends on that feature. */
export interface BlockedAssessment {
  /** Keywords the scenario mentioned when this was decided. */
  keywords: string[];
  blocked: boolean;
  /** Null for keyword-only verdicts. */
  confidence: BlockedConfidence | null;
  reason: string;
  source: "ai" | "keyword";
  at: string;
}

export interface MissingRow {
  tcId: string;
  testScenario: string;
  reason: string;
}

export interface TestSetComparison {
  testSetId: number;
  testSetName: string;
  platform: Platform;
  comparedAt: string;
  cards: Card[];
  missingFromSpira: MissingRow[];
  /** Test-set membership IDs present in Spira when this comparison ran. */
  baselineMembership: number[];
  /** Server signature over the cards, suggestions and baseline; checked before any apply. */
  seal: string;
}

export interface CardChange {
  key: string;
  from: Column;
  to: Column;
}

export interface HistoryEntry {
  at: string;
  label: string;
  changes: CardChange[];
}

export type DraftStatus = "draft" | "applied" | "appliedWithErrors";

export interface PreflightSetResult {
  testSetId: number;
  ok: boolean;
  unexpected: number[];
  missing: number[];
  error?: string;
}

export interface PreflightResult {
  at: string;
  ok: boolean;
  sets: PreflightSetResult[];
  /** Present only on a passing check; binds it to the comparisons and decisions it covered. */
  seal: string | null;
}

export interface VerificationSetResult {
  testSetId: number;
  ok: boolean;
  stillPresent: number[];
  unexpectedlyRemoved: number[];
  error?: string;
}

export interface VerificationResult {
  at: string;
  ok: boolean;
  sets: VerificationSetResult[];
}

export interface DraftApplyState {
  preflight: PreflightResult | null;
  /** Membership IDs successfully removed by live apply, keyed by test set ID. */
  removed: Record<string, number[]>;
  failed: Record<string, number[]>;
  verification: VerificationResult | null;
  lastLiveRunAt: string | null;
  lastDryRunAt: string | null;
  /** Test runs this app recorded in Spira; kept so they can be undone. Missing on older drafts. */
  signOffRuns?: SignOffRun[];
  /** Cards whose result could not be recorded, so they can be retried. */
  signOffFailed?: SignOffAction[];
}

/** One card to record a result for. */
export interface SignOffAction {
  testSetId: number;
  testCaseId: number;
  testSetTestCaseId: number;
  status: SignOffStatus;
}

export interface SignOffRun extends SignOffAction {
  testRunId: number;
  at: string;
}

export type SignOffResultStatus = "recorded" | "wouldRecord" | "skipped" | "failed";

export interface SignOffResult extends SignOffAction {
  result: SignOffResultStatus;
  testRunId: number | null;
  message: string | null;
}

export interface DraftSource {
  fileName: string;
  inScopeSheet: string;
  needsConfirmationSheet: string | null;
}

export interface Draft {
  id: string;
  name: string;
  module: string;
  projectId: number;
  /** Optional: only labels the draft; Spira calls do not depend on it. */
  releaseId: number | null;
  releaseLabel: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  source: DraftSource;
  rows: WorkbookRow[];
  testSetIds: number[];
  /** Name and platform of each test set as chosen on Compare. Missing on older drafts. */
  testSetRefs?: TestSetRef[];
  testSets: TestSetComparison[];
  compareErrors: Record<string, string>;
  decisions: Record<string, Column>;
  history: HistoryEntry[];
  apply: DraftApplyState;
  /** Features not built yet, keyed by test set ID; In Scope cards mentioning one are moved to Blocked. */
  testSetKeywords?: Record<string, string[]>;
  /** Blocked/not-blocked verdicts for cases whose scenario mentions a keyword, keyed by card key. */
  blockedReview?: Record<string, BlockedAssessment>;
  /** When Filter last ran. */
  keywordsFilteredAt?: string | null;
}

export interface ColumnCounts {
  inScope: number;
  blocked: number;
  outOfScope: number;
  needsReview: number;
  total: number;
}

export interface DraftSummary {
  id: string;
  name: string;
  module: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  testSetIds: number[];
  comparedTestSetIds: number[];
  complete: boolean;
  counts: ColumnCounts;
  missingFromSpira: number;
  manualDecisions: number;
}

export interface TestSetRef {
  testSetId: number;
  testSetName: string;
  platform: Platform;
}

export interface TestSetMapping extends TestSetRef {
  id: string;
  module: string;
}

/** Saved in the browser. Holds nothing secret; Spira credentials live on the server. */
export interface AppSettings {
  /** Null until chosen in Settings. */
  projectId: number | null;
  releaseId: number | null;
  releaseLabel: string;
  mappings: TestSetMapping[];
  moduleAliases: Record<string, string>;
  updatedAt: string | null;
}

/** One answer from the AI review. */
export interface AiBlockedVerdict {
  key: string;
  blocked: boolean;
  confidence: BlockedConfidence;
  reason: string;
}

/** Server-side Gemini configuration. Never includes the API key. */
export interface AiStatus {
  configured: boolean;
  model: string;
}

/** Server-side Spira configuration as shown in Settings. Never includes the API key. */
export interface SpiraStatus {
  configured: boolean;
  host: string | null;
  username: string | null;
  apiKeyConfigured: boolean;
  problems: string[];
}

export interface SpiraProject {
  projectId: number;
  name: string;
}

export interface SpiraRelease {
  releaseId: number;
  name: string;
  versionNumber: string;
  /** "version - name", as shown on boards. */
  label: string;
  /** 0 for top-level releases, 1+ for sprints and iterations under them. */
  depth: number;
  active: boolean;
  type: string | null;
}

export interface SpiraTestSetSummary {
  testSetId: number;
  name: string;
  releaseId: number | null;
  releaseVersion: string | null;
}

/** Identifies what a comparison or membership check was run against. */
export interface WorkflowContext {
  projectId: number;
  releaseId: number | null;
  module: string;
}

export type ApplyActionStatus = "removed" | "wouldRemove" | "failed" | "skipped";

export interface ApplyAction {
  testCaseId: number;
  testSetTestCaseId: number;
}

export interface ApplyActionResult extends ApplyAction {
  status: ApplyActionStatus;
  message: string | null;
}

export interface ActivityEntry {
  id: string;
  at: string;
  type: string;
  message: string;
  draftId: string | null;
  module: string | null;
  details: Record<string, unknown> | null;
}
