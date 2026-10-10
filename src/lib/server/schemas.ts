import "server-only";
import { z } from "zod";
import { MAX_APPLY_BATCH } from "@/lib/domain/board";
import { COLUMNS, PLATFORMS } from "@/lib/domain/types";

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
  releaseId: id,
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

export const verifyRequestSchema = z.object({
  context: contextSchema,
  testSets,
  decisions,
});

export const releaseLookupSchema = z.object({ projectId: id, releaseId: id });

export const releaseListSchema = z.object({ projectId: id });

export const testSetListSchema = z.object({ projectId: id, releaseId: id.nullable() });
