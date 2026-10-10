import "server-only";
import { z } from "zod";
import { COLUMNS } from "@/lib/domain/types";

const cell = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const workbookRowSchema = z.object({
  sheet: z.string().max(200),
  rowNumber: z.number().int().positive(),
  scope: z.enum(["inScope", "needsConfirmation"]),
  values: z.record(z.string().max(300), cell),
});

export const createDraftSchema = z.object({
  name: z.string().trim().min(1, "Give the draft a name.").max(160),
  module: z.string().trim().min(1).max(120),
  source: z.object({
    fileName: z.string().max(260),
    inScopeSheet: z.string().min(1).max(200),
    needsConfirmationSheet: z.string().max(200).nullable(),
  }),
  rows: z.array(workbookRowSchema).max(20_000),
  testSetIds: z.array(z.number().int().positive()).min(1, "Choose at least one test set.").max(50),
});

const column = z.enum(COLUMNS);

export const updateDraftSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  decisions: z.record(z.string().max(64), column).optional(),
  history: z
    .array(
      z.object({
        at: z.string().max(40),
        label: z.string().max(300),
        changes: z
          .array(z.object({ key: z.string().max(64), from: column, to: column }))
          .max(50_000),
      }),
    )
    .max(5_000)
    .optional(),
  expectedUpdatedAt: z.string().max(40).optional(),
});

export const applyBatchSchema = z.object({
  testSetId: z.number().int().positive(),
  dryRun: z.boolean(),
  confirmModule: z.string().max(200).optional(),
  actions: z
    .array(
      z.object({
        testCaseId: z.number().int().positive(),
        testSetTestCaseId: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(25),
});
