export const COLUMNS = ["inScope", "outOfScope", "needsReview"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  inScope: "In Scope",
  outOfScope: "Out of Scope",
  needsReview: "Needs Review",
};

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
  releaseId: number;
  releaseLabel: string;
  status: DraftStatus;
  createdAt: string;
  updatedAt: string;
  source: DraftSource;
  rows: WorkbookRow[];
  testSetIds: number[];
  testSets: TestSetComparison[];
  compareErrors: Record<string, string>;
  decisions: Record<string, Column>;
  history: HistoryEntry[];
  apply: DraftApplyState;
}

export interface ColumnCounts {
  inScope: number;
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

export interface TestSetMapping {
  id: string;
  module: string;
  testSetId: number;
  testSetName: string;
  platform: Platform;
}

/** Saved in the browser. Holds nothing secret; Spira credentials live on the server. */
export interface AppSettings {
  projectId: number;
  releaseId: number;
  releaseLabel: string;
  mappings: TestSetMapping[];
  moduleAliases: Record<string, string>;
  updatedAt: string | null;
}

/** Server-side Spira configuration as shown in Settings. Never includes the API key. */
export interface SpiraStatus {
  configured: boolean;
  host: string | null;
  username: string | null;
  apiKeyConfigured: boolean;
  problems: string[];
}

/** Identifies what a comparison or membership check was run against. */
export interface WorkflowContext {
  projectId: number;
  releaseId: number;
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
