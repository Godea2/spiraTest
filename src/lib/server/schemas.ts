import "server-only";
import { z } from "zod";
import { MAX_APPLY_BATCH } from "@/lib/domain/board";
import { MAX_ATTACHMENT_BASE64, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_CAPTION } from "@/lib/domain/defect-report";
import {
  MAX_DEFECT_CANDIDATES,
  MAX_DEFECT_SEARCH_CASES,
  MAX_EXISTING_DEFECT_POOL,
  MAX_DEFECT_TEXT,
  MAX_DEFECT_VERIFY_BATCH,
  MAX_NEW_CASE_CHOICES,
  MAX_NEW_CASE_SETS,
  MAX_NEW_CASE_STEPS,
  MAX_RELATED_TERMS,
  MAX_STEP_TEXT,
  MAX_VERIFY_STEPS,
} from "@/lib/domain/defects";
import { MAX_PROGRESS_TEXT } from "@/lib/domain/progress";
import { MAX_NOTES_TEXT } from "@/lib/domain/notes";
import { MAX_EXECUTION_BATCH } from "@/lib/domain/execution";
import { keywordListSchema, MAX_AI_REVIEW_BATCH, MAX_SCENARIO_TEXT } from "@/lib/domain/keywords";
import { MAX_RUN_DETAILS } from "@/lib/domain/mirror";
import { MAX_REPORT_LINKS, MAX_REPORT_SETS } from "@/lib/domain/report";
import { COLUMNS, EXECUTION_STATUSES, PLATFORMS, RECORD_STATUSES, SIGN_OFF_STATUSES, STEP_STATUSES } from "@/lib/domain/types";

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

export const testSetStatusRequestSchema = z.object({ projectId: id, testSetId: id });

const executedStepSchema = z.object({
  label: z.string().max(20),
  testStepId: id.nullish(),
  linkedTestCaseId: id.nullish(),
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
          status: z.enum(RECORD_STATUSES),
          comment: z.string().max(4_000),
          steps: z.array(executedStepSchema).max(300),
        }),
      )
      .min(1)
      .max(MAX_EXECUTION_BATCH, `Send at most ${MAX_EXECUTION_BATCH} results per batch.`),
  }),
});

export const mirrorAddRequestSchema = z.object({
  target: z.object({ context: contextSchema, testSets }),
  source: z.object({ context: contextSchema, testSets, decisions }),
  testSetId: id,
  sourceTestSetId: id,
  testCaseIds: z.array(id).min(1).max(MAX_APPLY_BATCH, `Send at most ${MAX_APPLY_BATCH} test cases per batch.`),
});

export const runDetailRequestSchema = z.object({
  projectId: id,
  testRunIds: z.array(id).min(1).max(MAX_RUN_DETAILS, `Send at most ${MAX_RUN_DETAILS} runs per request.`),
});

const defectText = z.string().trim().min(10, "Describe the defect in a sentence or two.").max(MAX_DEFECT_TEXT);
const stepText = z.string().max(MAX_STEP_TEXT);

const moduleName = z.string().trim().min(1).max(200);

export const defectUnderstandRequestSchema = z.object({
  description: defectText,
  modules: z
    .array(z.object({ module: moduleName, testSets: z.array(z.string().max(200)).max(12) }))
    .max(60, "Search at most 60 modules at a time."),
});

const analysisSchema = z.object({
  area: z.string().max(200),
  symptom: z.string().max(600),
  expected: z.string().max(600),
  feature: z.string().max(200).default(""),
  related: z.array(z.string().max(80)).max(MAX_RELATED_TERMS).default([]),
});

const searchCaseSchema = z.object({
  key: z.string().max(64),
  module: moduleName,
  testSetName: z.string().max(200),
  scenario: z.string().max(MAX_SCENARIO_TEXT),
  workbookScenario: z.string().max(MAX_SCENARIO_TEXT).optional(),
});

export const defectSearchRequestSchema = z.object({
  description: defectText,
  analysis: analysisSchema,
  cases: z.array(searchCaseSchema).min(1).max(MAX_DEFECT_SEARCH_CASES, `Send at most ${MAX_DEFECT_SEARCH_CASES} cases per request.`),
});

export const defectFindExistingRequestSchema = z.object({
  description: defectText,
  analysis: analysisSchema,
  existing: z
    .array(
      z.object({
        key: z.string().max(80),
        source: z.enum(["spira", "app"]),
        incidentId: z.number().int().positive().nullable(),
        recordId: z.string().max(80).nullable(),
        title: z.string().max(300),
        text: z.string().max(2_000),
        status: z.string().max(120).nullable(),
        open: z.boolean(),
      }),
    )
    .max(MAX_EXISTING_DEFECT_POOL, `Send at most ${MAX_EXISTING_DEFECT_POOL} existing defects per request.`),
});

const progressText = z.string().trim().min(10, "Describe what you tested in a sentence or two.").max(MAX_PROGRESS_TEXT);

export const progressUnderstandRequestSchema = z.object({
  description: progressText,
  modules: z
    .array(z.object({ module: moduleName, testSets: z.array(z.string().max(200)).max(12) }))
    .max(60, "Search at most 60 modules at a time."),
});

export const notesParseRequestSchema = z.object({
  notes: z.string().trim().min(20, "Paste a few lines of tester notes.").max(MAX_NOTES_TEXT),
  modules: z.array(moduleName).max(60),
});

export const progressSearchRequestSchema = z.object({
  description: progressText,
  analysis: z.object({
    feature: z.string().max(200),
    related: z.array(z.string().max(80)).max(MAX_RELATED_TERMS),
    area: z.string().max(200),
    summary: z.string().max(300),
  }),
  cases: z.array(searchCaseSchema).min(1).max(MAX_DEFECT_SEARCH_CASES, `Send at most ${MAX_DEFECT_SEARCH_CASES} cases per request.`),
});

export const defectNewCaseRequestSchema = z.object({
  description: defectText,
  analysis: analysisSchema,
  testSets: z
    .array(
      z.object({
        key: z.string().max(80),
        module: moduleName,
        testSetName: z.string().max(200),
        platform: z.enum(PLATFORMS),
        examples: z.array(z.string().max(MAX_SCENARIO_TEXT)).max(8),
      }),
    )
    .min(1)
    .max(MAX_NEW_CASE_CHOICES),
});

const newStepText = z.string().trim().max(2_000);

export const defectCaseCreateRequestSchema = z.object({
  boards: z.array(z.object({ context: contextSchema, testSets, decisions })).min(1).max(MAX_NEW_CASE_SETS),
  testCase: z.object({
    name: z.string().trim().min(5, "Give the test case a name.").max(255),
    description: z.string().trim().max(4_000),
    /** The test case's status in Spira; null or left out for the project's default. */
    statusId: id.nullable().optional(),
    steps: z
      .array(z.object({ description: newStepText.min(3, "Every step needs an action."), expectedResult: newStepText }))
      .min(1, "Give the test case at least one step.")
      .max(MAX_NEW_CASE_STEPS, `A new test case can have at most ${MAX_NEW_CASE_STEPS} steps.`),
  }),
  targets: z
    .array(z.object({ board: z.number().int().min(0).max(MAX_NEW_CASE_SETS - 1), testSetId: id }))
    .min(1, "Choose a test set.")
    .max(MAX_NEW_CASE_SETS, `Add a new test case to at most ${MAX_NEW_CASE_SETS} test sets.`),
});

export const defectCaseUndoRequestSchema = z.object({
  projectId: id,
  testCaseId: id,
  memberships: z.array(z.object({ testSetId: id, testSetTestCaseId: id })).max(MAX_NEW_CASE_SETS),
  /** The boards holding those memberships, to be sealed again without the deleted case. */
  boards: z.array(z.object({ context: contextSchema, testSets })).max(MAX_NEW_CASE_SETS).optional(),
});

export const defectVerifyRequestSchema = z.object({
  description: defectText,
  analysis: analysisSchema,
  cases: z
    .array(
      z.object({
        key: z.string().max(64),
        module: moduleName.optional(),
        name: z.string().max(2_000),
        steps: z
          .array(z.object({ label: z.string().max(20), description: stepText, expectedResult: stepText, sampleData: stepText }))
          .max(MAX_VERIFY_STEPS),
      }),
    )
    .min(1)
    .max(MAX_DEFECT_VERIFY_BATCH, `Send at most ${MAX_DEFECT_VERIFY_BATCH} cases per request.`),
});

const optionalId = id.nullable();

/** Boards (one per module) a defect can span; each run names the board it belongs to. */
export const MAX_DEFECT_BOARDS = 20;

export const defectLogRequestSchema = z.object({
  boards: z
    .array(z.object({ context: contextSchema, testSets, decisions }))
    .min(1)
    .max(MAX_DEFECT_BOARDS, `A defect can span at most ${MAX_DEFECT_BOARDS} modules.`),
  defect: z.object({
    name: z.string().trim().min(3, "Give the defect a title.").max(255),
    description: z.string().trim().min(10).max(20_000),
    typeId: optionalId,
    priorityId: optionalId,
    severityId: optionalId,
  }),
  runs: z
    .array(z.object({ board: z.number().int().min(0).max(MAX_DEFECT_BOARDS - 1), testRunId: id, testCaseId: id, testSetId: id, testSetTestCaseId: id }))
    .min(1)
    .max(MAX_DEFECT_CANDIDATES, `Link at most ${MAX_DEFECT_CANDIDATES} runs to one defect.`),
  files: z
    .array(z.object({ documentId: id, caption: z.string().max(MAX_CAPTION), kind: z.enum(["image", "video", "file"]) }))
    .max(MAX_ATTACHMENTS, `Attach at most ${MAX_ATTACHMENTS} files to one defect.`)
    .optional(),
});

export const defectUndoRequestSchema = z.object({ projectId: id, incidentId: id });

export const defectFileRequestSchema = z
  .object({
    projectId: id,
    incidentId: id.nullable(),
    testRunIds: z.array(id).max(MAX_DEFECT_CANDIDATES),
    file: z.object({
      name: z.string().trim().min(1).max(255),
      caption: z.string().trim().max(MAX_CAPTION),
      data: z
        .string()
        .min(1, "The file is empty.")
        .max(MAX_ATTACHMENT_BASE64, `Attach files of at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, "The file must be sent as base64."),
    }),
  })
  .refine((input) => input.incidentId !== null || input.testRunIds.length > 0, { message: "Name the incident or the runs to attach the file to.", path: ["testRunIds"] });

export const defectFileUndoRequestSchema = z.object({ projectId: id, documentId: id });

export const projectLookupSchema = z.object({ projectId: id });

export const incidentStatusUpdateSchema = z.object({
  projectId: id,
  incidentId: id,
  statusId: id,
});

export const incidentDescriptionLookupSchema = z.object({
  projectId: id,
  incidentId: id,
});

export const incidentDescriptionUpdateSchema = z.object({
  projectId: id,
  incidentId: id,
  description: z.string().max(50_000),
});

export const releaseLookupSchema = z.object({ projectId: id, releaseId: id });

export const testCaseLookupSchema = z.object({ projectId: id, testCaseId: id });

export const releaseListSchema = z.object({ projectId: id });

export const testSetListSchema = z.object({ projectId: id, releaseId: id.nullable() });

export const weekCatalogRequestSchema = z.object({
  projectId: id,
  releaseId: id,
  releaseLabel: z.string().trim().max(200),
});

const weekModuleSchema = z.object({
  module: z.string().trim().min(1).max(120),
  context: contextSchema,
  testSets,
  caseCount: z.number().int().nonnegative(),
});

export const weekRecordRequestSchema = z.object({
  catalog: z.object({
    projectId: id,
    releaseId: id,
    releaseLabel: z.string().trim().max(200),
    folderName: z.string().trim().max(200).nullable(),
    source: z.enum(["release", "folder"]).default("release"),
    modules: z.array(weekModuleSchema).min(1).max(80),
    testSetCount: z.number().int().nonnegative(),
    caseCount: z.number().int().nonnegative(),
  }),
  tester: z.string().trim().min(1, "Enter the tester's name.").max(100),
  batches: z
    .array(
      z.object({
        module: z.string().trim().min(1).max(120),
        testSetId: id,
        cases: z
          .array(
            z.object({
              testCaseId: id,
              testSetTestCaseId: id,
              status: z.enum(RECORD_STATUSES),
              comment: z.string().max(4_000),
              steps: z.array(executedStepSchema).max(300),
            }),
          )
          .min(1)
          .max(MAX_EXECUTION_BATCH),
      }),
    )
    .min(1)
    .max(200),
});

export const reportResultsRequestSchema = z.object({ projectId: id, testSetIds: z.array(id).min(1).max(MAX_REPORT_SETS) });
export const reportLinksRequestSchema = z.object({ projectId: id, testCaseIds: z.array(id).min(1).max(MAX_REPORT_LINKS) });
