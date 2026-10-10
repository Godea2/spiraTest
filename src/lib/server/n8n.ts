import "server-only";
import { z } from "zod";
import { cardKey } from "@/lib/domain/board";
import type {
  ApplyAction,
  ApplyActionResult,
  Column,
  EndpointKind,
  Platform,
  WorkbookRow,
} from "@/lib/domain/types";
import { ENDPOINT_ENV, resolveEndpoint, webhookSecret } from "./endpoints";
import type { ReconcileOutput } from "./mock";

export class AutomationError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

const TIMEOUT_MS: Record<EndpointKind, number> = { reconcile: 120_000, apply: 90_000 };
const LABEL: Record<EndpointKind, string> = { reconcile: "Reconcile", apply: "Apply" };

function normalizeSuggestion(value: string): Column | null {
  const key = value.replace(/[\s_-]/g, "").toLowerCase();
  if (key === "inscope" || key === "keep" || key === "in") return "inScope";
  if (key === "outofscope" || key === "remove" || key === "out") return "outOfScope";
  if (key === "needsreview" || key === "review" || key === "needsconfirmation") return "needsReview";
  return null;
}

const numeric = z.coerce.number().int().positive();

const reconcileResponseSchema = z.object({
  cards: z
    .array(
      z.object({
        testCaseId: numeric,
        testSetTestCaseId: numeric,
        name: z.string().default(""),
        tcId: z.string().nullish(),
        executionStatus: z.string().nullish(),
        executed: z.boolean().nullish(),
        suggestion: z.string(),
        reason: z.string().nullish(),
      }),
    )
    .max(20_000),
  missingFromSpira: z
    .array(
      z.object({
        tcId: z.coerce.string(),
        testScenario: z.coerce.string().default(""),
        reason: z.string().nullish(),
      }),
    )
    .default([]),
  membership: z.array(numeric).optional(),
});

const applyResponseSchema = z.object({
  results: z.array(
    z.object({
      testSetTestCaseId: numeric,
      testCaseId: numeric.optional(),
      status: z.enum(["removed", "wouldRemove", "failed", "skipped"]),
      message: z.string().nullish(),
      error: z.string().nullish(),
    }),
  ),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

async function postToWebhook(
  kind: EndpointKind,
  override: string | null,
  body: unknown,
): Promise<unknown> {
  const endpoint = resolveEndpoint(kind, override);
  if (endpoint.error) throw new AutomationError(endpoint.error, 503);
  if (!endpoint.url) {
    throw new AutomationError(
      `No ${LABEL[kind]} webhook is configured. Add one in Settings or set ${ENDPOINT_ENV[kind]}, or turn on Mock mode.`,
      503,
    );
  }
  const secret = webhookSecret();
  if (!secret) {
    throw new AutomationError(
      "WEBHOOK_SECRET is not set on the server, so n8n requests are disabled. Add it to the server environment.",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Webhook-Secret": secret,
      },
      body: JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS[kind]),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new AutomationError(
        `The ${LABEL[kind]} workflow did not answer within ${TIMEOUT_MS[kind] / 1000}s. Check that the n8n workflow is active.`,
        504,
      );
    }
    throw new AutomationError(
      `Could not reach the ${LABEL[kind]} workflow at ${endpoint.url.host}. Check the URL and that n8n is running.`,
      502,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AutomationError(
      `n8n rejected the request (HTTP ${response.status}). Check that WEBHOOK_SECRET matches the secret the workflow expects.`,
      502,
    );
  }
  if (response.status === 404) {
    throw new AutomationError(
      `The ${LABEL[kind]} webhook was not found (HTTP 404). Check the URL and that the workflow is active (production URL, not test URL).`,
      502,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new AutomationError(
      `The ${LABEL[kind]} workflow failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
      502,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new AutomationError(
      `The ${LABEL[kind]} workflow answered with something other than JSON. Make sure its "Respond to Webhook" node returns JSON.`,
      502,
    );
  }
}

export interface ReconcileRequest {
  projectId: number;
  releaseId: number;
  module: string;
  testSetId: number;
  testSetName: string;
  platform: Platform;
  rows: WorkbookRow[];
}

export async function n8nReconcile(
  override: string | null,
  request: ReconcileRequest,
): Promise<ReconcileOutput> {
  const raw = await postToWebhook("reconcile", override, request);
  const parsed = reconcileResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AutomationError(
      `The Reconcile workflow returned an unexpected shape (${describeIssues(parsed.error)}).`,
      502,
    );
  }
  const cards = parsed.data.cards.map((card, index) => {
    const suggestion = normalizeSuggestion(card.suggestion);
    if (!suggestion) {
      throw new AutomationError(
        `The Reconcile workflow returned an unknown suggestion "${card.suggestion}" for card ${index + 1}. Use inScope, outOfScope or needsReview.`,
        502,
      );
    }
    return {
      key: cardKey(request.testSetId, card.testSetTestCaseId),
      testSetId: request.testSetId,
      testCaseId: card.testCaseId,
      testSetTestCaseId: card.testSetTestCaseId,
      name: card.name,
      tcId: card.tcId ?? null,
      executionStatus: card.executionStatus ?? (card.executed ? "Executed" : "Not Run"),
      executed: card.executed ?? Boolean(card.executionStatus && card.executionStatus !== "Not Run"),
      suggestion,
      reason: card.reason ?? "",
    };
  });
  const keys = new Set<string>();
  for (const card of cards) {
    if (keys.has(card.key)) {
      throw new AutomationError(
        `The Reconcile workflow returned membership ${card.testSetTestCaseId} more than once.`,
        502,
      );
    }
    keys.add(card.key);
  }
  return {
    cards,
    membership: parsed.data.membership ?? cards.map((card) => card.testSetTestCaseId),
    missingFromSpira: parsed.data.missingFromSpira.map((row) => ({
      tcId: row.tcId,
      testScenario: row.testScenario,
      reason: row.reason ?? "",
    })),
  };
}

export async function n8nApply(
  override: string | null,
  request: {
    projectId: number;
    releaseId: number;
    testSetId: number;
    dryRun: boolean;
    actions: ApplyAction[];
  },
): Promise<ApplyActionResult[]> {
  const raw = await postToWebhook("apply", override, {
    ...request,
    actions: request.actions.map((action) => ({ action: "remove", ...action })),
  });
  const parsed = applyResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AutomationError(
      `The Apply workflow returned an unexpected shape (${describeIssues(parsed.error)}).`,
      502,
    );
  }
  const byMembership = new Map(parsed.data.results.map((r) => [r.testSetTestCaseId, r]));
  // Anything the workflow did not report on is treated as failed so it stays eligible for retry.
  return request.actions.map((action) => {
    const result = byMembership.get(action.testSetTestCaseId);
    if (!result) {
      return { ...action, status: "failed", message: "The Apply workflow did not report a result for this case." };
    }
    if (request.dryRun && result.status === "removed") {
      return { ...action, status: "failed", message: "Workflow reported a removal during a dry run. Check the workflow's dryRun handling." };
    }
    return { ...action, status: result.status, message: result.message ?? result.error ?? null };
  });
}
