/** Defects: In Scope cases with a defect found against them. They stay in their test set and are executed (as Failed). */
export const COLUMNS = ["inScope", "defects", "blocked", "outOfScope", "needsReview"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  inScope: "In Scope",
  defects: "Defects",
  blocked: "Blocked",
  outOfScope: "Out of Scope",
  needsReview: "Needs Review",
};

/** Results the app records in Spira on sign-off. */
export const SIGN_OFF_STATUSES = ["blocked", "passed"] as const;
export type SignOffStatus = (typeof SIGN_OFF_STATUSES)[number];

/** Results a tester can record for a whole test case. */
export const EXECUTION_STATUSES = ["passed", "failed", "blocked", "caution"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Results for one step; a step that does not apply can be marked N/A. */
export const STEP_STATUSES = ["passed", "failed", "blocked", "caution", "notApplicable"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

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
  /** Keywords the case depends on, per the AI. For a deep check these may not appear in the scenario. */
  features?: string[];
  /** The test set's keyword list when this was decided; a deep check is redone when it changes. */
  against?: string[];
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
  /** When the draft completed without a live apply, because nothing had to change in Spira. */
  completedWithoutChanges?: string | null;
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
  /** Test execution of the In Scope cases, once the draft is completed. Missing until it starts. */
  execution?: DraftExecution;
}

/** A step as executed: its text from Spira and what the tester found. Labels are "3", or "3.2" inside a linked test case. */
export interface ExecutedStep {
  label: string;
  /** Spira's test step ID, used to match the step in the run Spira creates. */
  testStepId?: number | null;
  /** Set when the step calls a test case whose steps were not loaded. */
  linkedTestCaseId?: number | null;
  description: string;
  expectedResult: string;
  status: StepStatus | null;
  actualResult: string;
}

/** Marks a tester has made on a case but not sent to Spira yet. */
export interface ExecutionProgress {
  steps: Record<string, { status: StepStatus | null; actualResult: string }>;
  /** Result chosen for a case without steps. */
  status: ExecutionStatus | null;
  comment: string;
}

/** A test run this app recorded during execution; kept so it can be undone. */
export interface ExecutionRun {
  testSetId: number;
  testCaseId: number;
  testSetTestCaseId: number;
  status: ExecutionStatus;
  testRunId: number;
  at: string;
  tester: string;
  comment: string;
}

/** Execution status of one membership as last read from Spira. */
export interface SpiraExecutionState {
  statusId: number | null;
  status: string;
}

export interface DraftExecution {
  runs: ExecutionRun[];
  /** Keyed by card key. */
  progress: Record<string, ExecutionProgress>;
  /** Keyed by card key. */
  spira: Record<string, SpiraExecutionState>;
  checkedAt: string | null;
  /** Each test set's own status in Spira, keyed by test set ID; expectedId is set when its cases call for another. */
  testSets?: Record<string, TestSetStatusState>;
  /** Defects kept here before they moved to their own list; moved there when the Defects page first loads. */
  defects?: unknown[];
}

export const DEFECT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

/** How Gemini reads a defect description. */
export interface DefectAnalysis {
  /** A bug title: "<screen or feature>: <what goes wrong>". */
  title: string;
  area: string;
  /** The feature or journey the defect is in, as a tester would name it ("Airtime purchase"). */
  feature: string;
  /** Other names for that feature and the screens, controls and journeys that use it ("top-up", "recharge"). */
  related: string[];
  symptom: string;
  /** What should happen instead; empty when the description does not say. */
  expected: string;
  severity: DefectSeverity;
  /** One question that would sharpen the search when the description is too vague; null otherwise. */
  question: string | null;
}

/** A case Gemini picked from names alone as possibly affected; its steps are checked next. */
export interface DefectCandidate {
  key: string;
  relevance: BlockedConfidence;
}

export type DefectVerdict = "fails" | "possible" | "unaffected";

/** Whether a defect makes a case fail, judged from the case's steps. */
export interface DefectMatch {
  key: string;
  verdict: DefectVerdict;
  confidence: BlockedConfidence;
  /** Step where the tester meets the defect; null for a case without steps or when none applies. */
  stepLabel: string | null;
  /** Words copied from the case that show it exercises the broken behaviour. */
  evidence: string;
  /** True when the evidence was found, word for word, in the case's own text. */
  grounded: boolean;
  reason: string;
}

/** One case failed for a defect: where it lives, its run, and the board column it was in before. */
export interface DefectCaseRecord {
  draftId: string;
  module: string;
  testSetId: number;
  testCaseId: number;
  testSetTestCaseId: number;
  name: string;
  testRunId: number;
  stepLabel: string | null;
  /** Column the card was in before it moved to Defects; restored on undo. */
  from: Column;
}

/** A defect found here: the cases failed for it, across modules, and the Spira incident linked to their runs. */
export interface DefectRecord {
  id: string;
  projectId: number;
  at: string;
  title: string;
  description: string;
  tester: string;
  /** The incident's description as logged, kept so logging can be retried. */
  report: string;
  incidentId: number | null;
  /** Failed run steps the incident is linked to. */
  linkedSteps: number;
  cases: DefectCaseRecord[];
  /** A test case this app created in Spira for the defect, because no existing case covered it. */
  created?: CreatedDefectCase | null;
}

export interface CreatedDefectCase {
  testCaseId: number;
  name: string;
  memberships: Array<{ draftId: string; module: string; testSetId: number; testSetTestCaseId: number }>;
}

/** A test case written for a defect no existing case covers: what Gemini drafts and the tester edits. */
export interface NewDefectCase {
  name: string;
  description: string;
  steps: Array<{ description: string; expectedResult: string }>;
  /** 1-based position of the step where the defect shows. */
  failingStep: number;
  /** The test case's status in Spira; null or left out for the project's default. */
  statusId?: number | null;
}

export interface NewDefectCaseSuggestion extends NewDefectCase {
  /** Test sets it belongs in (draft ID and test set ID joined by "|"), best first. */
  testSetKeys: string[];
  reason: string;
}

/** What creating a defect's test case did in Spira. */
export interface DefectCaseCreated {
  testCaseId: number;
  memberships: Array<{ testSetId: number; testSetTestCaseId: number }>;
}

export interface IncidentOption {
  id: number;
  name: string;
}

/** The project's incident lists, for the defect form. */
export interface IncidentOptions {
  types: IncidentOption[];
  priorities: IncidentOption[];
  severities: IncidentOption[];
  defaultTypeId: number | null;
  /** The project's test case statuses, for a test case created for a defect; empty when they could not be read. */
  testCaseStatuses: IncidentOption[];
}

export interface DefectLogResult {
  incidentId: number;
  linked: Array<{ testRunId: number; testRunStepId: number }>;
  unlinked: Array<{ testRunId: number; message: string }>;
}

export interface TestSetStatusState {
  statusId: number | null;
  name: string;
  expectedId: number | null;
}

export interface ExecutionCaseInput {
  testCaseId: number;
  testSetTestCaseId: number;
  status: ExecutionStatus;
  comment: string;
  steps: ExecutedStep[];
}

export interface ExecutionResult {
  testSetId: number;
  testCaseId: number;
  testSetTestCaseId: number;
  status: ExecutionStatus;
  result: "recorded" | "skipped" | "failed";
  testRunId: number | null;
  message: string | null;
  /** Execution status the test set shows in Spira when read back right after saving; absent when it could not be read. */
  spiraStatusId?: number | null;
}

/** Current execution status of each membership in a test set, read from Spira. */
export interface TestSetExecutionStatus {
  testSetId: number;
  cases: Array<{ testSetTestCaseId: number; testCaseId: number; statusId: number | null; status: string }>;
  /** The test set's own status in Spira, and the one its cases call for when that differs. */
  testSetStatus?: TestSetStatusState;
  error?: string;
}

/** What the app did to keep a test set's status, owner and planned date right after recording runs. */
export interface TestSetUpkeep {
  testSetId: number;
  statusId: number | null;
  statusName: string | null;
  changedStatus: boolean;
  restored: string[];
  error?: string;
}

export interface ColumnCounts {
  inScope: number;
  defects: number;
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
  /** When Spira was last verified to match the board; null until the draft is completed. */
  completedAt: string | null;
  /** In Scope cases with a result in Spira, as last read; null until execution starts. */
  execution?: { executed: number; total: number } | null;
  testSetIds: number[];
  comparedTestSetIds: number[];
  complete: boolean;
  counts: ColumnCounts;
  missingFromSpira: number;
  manualDecisions: number;
  /** Nothing to remove or review: only a read-only check against Spira stands between it and Completed. */
  readyToComplete: boolean;
  /** Completed without a live apply, because Spira already matched the board. */
  completedWithoutChanges: boolean;
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
  /** Not-implemented keywords the case depends on; empty when not blocked. */
  features: string[];
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
  /** Spira web address, for links to artifacts. */
  siteUrl: string | null;
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

/** One step of a test case, as plain text. A step that calls another test case carries that case's steps. */
export interface TestCaseStep {
  testStepId: number | null;
  position: number;
  description: string;
  expectedResult: string;
  sampleData: string;
  precondition: string;
  linkedTestCaseId: number | null;
  linkedName: string | null;
  linkedSteps: TestCaseStep[];
}

export interface TestCaseDetail {
  testCaseId: number;
  name: string;
  description: string;
  priority: string | null;
  status: string | null;
  type: string | null;
  author: string | null;
  owner: string | null;
  customFields: Array<{ name: string; value: string }>;
  steps: TestCaseStep[];
  /** True when the step list was cut short. */
  truncated: boolean;
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
