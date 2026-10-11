import "server-only";
import { z } from "zod";
import { MAX_APPLY_BATCH } from "@/lib/domain/board";
import { keywordListSchema, MAX_AI_REVIEW_BATCH, MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import { COLUMNS, EXECUTION_STATUSES, PLATFORMS, SIGN_OFF_STATUSES, STEP_STATUSES } from "@/lib/domain/types";

const id = z.number().int().positive();
const column = z.enum(COLUMNS);
const cell = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const workbookRowSchema = z.object({
  sheet: z.string().max(200),
  rowNumber: id,
  scope: z.enum(["inScope", "needsConfirmation"]),
  values: z.record(z.string().max(300), cell),
});

const rows = z.array(workbookRowSchema).max(20_000);

export const contextSchema = z.object({
  projectId: id,
  releaseId: id.nullable(),
  module: z.string().trim().min(1).max(120),
});

const testSetRef = z.object({
  testSetId: id,
  testSetName: z.string().max(200),
  platform: z.enum(PLATFORMS),
});

const cardSchema = z.object({
  key: z.string().max(64),
  testSetId: id,
  testCaseId: id,
  testSetTestCaseId: id,
  name: z.string().max(2_000),
  tcId: z.string().max(200).nullable(),
  executionStatus: z.string().max(200),
  executed: z.boolean(),
  suggestion: column,
  reason: z.string().max(2_000),
  workbookScenario: z.string().max(MAX_SCENARIO_TEXT).optional(),
});

const comparisonSchema = testSetRef.extend({
  comparedAt: z.string().max(40),
  cards: z.array(cardSchema).max(20_000),
  missingFromSpira: z
    .array(z.object({ tcId: z.string().max(200), testScenario: z.string().max(2_000), reason: z.string().max(2_000) }))
    .max(20_000),
  baselineMembership: z.array(id).max(20_000),
  seal: z.string().max(200),
});

const testSets = z.array(comparisonSchema).min(1).max(50);
const decisions = z.record(z.string().max(64), column);
const removed = z.record(z.string().max(20), z.array(id).max(20_000));

const preflightSchema = z.object({
  at: z.string().max(40),
  ok: z.boolean(),
  sets: z
    .array(
      z.object({
        testSetId: id,
        ok: z.boolean(),
        unexpected: z.array(id),
        missing: z.array(id),
        error: z.string().max(2_000).optional(),
      }),
    )
    .max(50),
  seal: z.string().max(200).nullable(),
});

export const reconcileSchema = z.object({
  context: contextSchema,
  testSet: testSetRef,
  rows,
});

export const preflightRequestSchema = z.object({
  context: contextSchema,
  testSets,
  decisions,
  removed,
});

export const applyRequestSchema = z.object({
  context: contextSchema,
  testSets,
  decisions,
  removed,
  preflight: preflightSchema.nullable(),
  batch: z.object({
    testSetId: id,
    dryRun: z.boolean(),
    confirmModule: z.string().max(200).optional(),
    actions: z
      .array(z.object({ testCaseId: id, testSetTestCaseId: id }))
      .min(1)
      .max(MAX_APPLY_BATCH, `Send at most ${MAX_APPLY_BATCH} actions per batch.`),
  }),
});

const actions = z
  .array(z.object({ testCaseId: id, testSetTestCaseId: id }))
  .min(1)
  .max(MAX_APPLY_BATCH, `Send at most ${MAX_APPLY_BATCH} actions per batch.`);

export const signOffRequestSchema = z.object({
  context: contextSchema,
  testSets,
  decisions,
  removed,
  preflight: preflightSchema.nullable(),
  draftName: z.string().trim().max(200),
  /** Keywords each card matched, shown in the Spira run message. Keyed by test set test case ID. */
  notes: z.record(z.string().max(20), z.string().max(300)).optional(),
  batch: z.object({
    testSetId: id,
    status: z.enum(SIGN_OFF_STATUSES),
    dryRun: z.boolean(),
    confirmModule: z.string().max(200).optional(),
    actions,
  }),
});

export const undoSignOffRequestSchema = z.object({
  context: contextSchema,
  runs: z
    .array(z.object({ testRunId: id, testCaseId: id }))
    .min(1)
    .max(MAX_APPLY_BATCH, `Send at most ${MAX_APPLY_BATCH} runs per batch.`),
});

export const blockedReviewRequestSchema = z.object({
  module: z.string().trim().min(1).max(200),
  cases: z
    .array(
      z.object({
        key: z.string().max(40),
        testSetName: z.string().max(200),
        scenario: z.string().max(MAX_SCENARIO_TEXT),
        workbookScenario: z.string().max(MAX_SCENARIO_TEXT).optional(),
        keywords: z.array(z.string().max(60)).max(20),
        allKeywords: keywordListSchema,
      }),
    )
    .min(1)
    .max(MAX_AI_REVIEW_BATCH, `Send at most ${MAX_AI_REVIEW_BATCH} cases per request.`),
});

export const verifyRequestSchema = z.object({
  context: contextSchema,
  testSets,
  decisions,
});

export const executionStatusRequestSchema = z.object({
  projectId: id,
  testSetIds: z.array(id).min(1).max(50),
});

const executedStepSchema = z.object({
  label: z.string().max(20),
  description: z.string().max(4_000),
  expectedResult: z.string().max(4_000),
  status: z.enum(STEP_STATUSES).nullable(),
  actualResult: z.string().max(4_000),
});

export const executionRecordRequestSchema = z.object({
  context: contextSchema,
  testSets,
  decisions,
  draftName: z.string().trim().max(200),
  tester: z.string().trim().max(100),
  batch: z.object({
    testSetId: id,
    cases: z
      .array(
        z.object({
          testCaseId: id,
          testSetTestCaseId: id,
          status: z.enum(EXECUTION_STATUSES),
          comment: z.string().max(4_000),
          steps: z.array(executedStepSchema).max(300),
        }),
      )
      .min(1)
      .max(MAX_APPLY_BATCH, `Send at most ${MAX_APPLY_BATCH} results per batch.`),
  }),
});

export const releaseLookupSchema = z.object({ projectId: id, releaseId: id });

export const testCaseLookupSchema = z.object({ projectId: id, testCaseId: id });

export const releaseListSchema = z.object({ projectId: id });

export const testSetListSchema = z.object({ projectId: id, releaseId: id.nullable() });
