import "server-only";
import { z } from "zod";
import { EXECUTED_STATUS_IDS, EXECUTION_STATUS, EXECUTION_STATUS_NAMES, RUNNER_NAME, runSignature, type RunStepSlot } from "@/lib/domain/execution";
import { incidentSignature, testCaseSignature } from "@/lib/domain/defects";
import { richText } from "@/lib/domain/text";
import type { IncidentOptions, SpiraProject, SpiraRelease, SpiraStatus, SpiraTestSetSummary, TestCaseDetail, TestCaseStep } from "@/lib/domain/types";

// Server-only client for the Spira REST API (v7.0). Credentials come from the environment
// and are sent as headers, never in the URL, so they do not end up in proxy or server logs.

export const SPIRA_ENV = {
  baseUrl: "SPIRA_BASE_URL",
  username: "SPIRA_USERNAME",
  apiKey: "SPIRA_API_KEY",
} as const;

const REST_PATH = "/Services/v7_0/RestService.svc";
const TIMEOUT_MS = 30_000;
const READ_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class SpiraError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    /** HTTP status Spira itself answered with, when it answered. */
    public readonly upstream: number | null = null,
  ) {
    super(message);
  }
}

export type BaseUrlCheck = { ok: true; restBase: string; host: string; siteUrl: string } | { ok: false; error: string };

/**
 * Accepts the Spira site URL (https://example.spiraservice.net) or the full REST URL and
 * returns the v7.0 REST base. HTTPS only; plain HTTP is allowed for localhost.
 */
export function validateSpiraBaseUrl(input: string): BaseUrlCheck {
  const value = input.trim();
  if (!value) return { ok: false, error: "Set the Spira site URL, for example https://yourcompany.spiraservice.net." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "Use a full URL, for example https://yourcompany.spiraservice.net." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    return { ok: false, error: "The Spira URL must use https://." };
  }
  if (url.username || url.password) return { ok: false, error: "Do not put credentials in the Spira URL." };
  if (url.search || url.hash) return { ok: false, error: "Remove the query string or #fragment from the Spira URL." };
  let path = url.pathname.replace(/\/+$/, "");
  const restIndex = path.toLowerCase().indexOf("/services/");
  if (restIndex >= 0) path = path.slice(0, restIndex);
  return { ok: true, restBase: `${url.origin}${path}${REST_PATH}`, host: url.host, siteUrl: `${url.origin}${path}` };
}

interface SpiraConfig {
  restBase: string;
  username: string;
  apiKey: string;
}

function readConfig(): { config: SpiraConfig | null; status: SpiraStatus } {
  const rawUrl = process.env[SPIRA_ENV.baseUrl] ?? "";
  const username = process.env[SPIRA_ENV.username]?.trim() ?? "";
  const apiKey = process.env[SPIRA_ENV.apiKey]?.trim() ?? "";
  const problems: string[] = [];
  const check = rawUrl.trim() ? validateSpiraBaseUrl(rawUrl) : null;
  if (!check) problems.push(`${SPIRA_ENV.baseUrl} is not set.`);
  else if (!check.ok) problems.push(`${SPIRA_ENV.baseUrl}: ${check.error}`);
  if (!username) problems.push(`${SPIRA_ENV.username} is not set.`);
  if (!apiKey) problems.push(`${SPIRA_ENV.apiKey} is not set.`);
  const status: SpiraStatus = {
    configured: problems.length === 0,
    host: check?.ok ? check.host : null,
    siteUrl: check?.ok ? check.siteUrl : null,
    username: username || null,
    apiKeyConfigured: apiKey.length > 0,
    problems,
  };
  const config = check?.ok && username && apiKey ? { restBase: check.restBase, username, apiKey } : null;
  return { config, status };
}

/** Configuration summary for the UI. Never includes the API key. */
export function spiraStatus(): SpiraStatus {
  return readConfig().status;
}

function requireConfig(): SpiraConfig {
  const { config, status } = readConfig();
  if (!config) {
    throw new SpiraError(`Spira is not configured on the server. ${status.problems.join(" ")}`, 503);
  }
  return config;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(response: Response | null, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  return 400 * 2 ** attempt;
}

/** Spira's service errors are HTML pages; keep the exception message, or the page text without markup. */
export function htmlErrorText(html: string): string {
  const text = richText(html.replace(/<head[\s\S]*?<\/head>/i, "")).replace(/\s+/g, " ").trim();
  const exception = /exception message is '([\s\S]*?)'\.? *(See server logs|The exception stack trace)/i.exec(text);
  return exception ? exception[1].trim() : text.replace(/ The exception stack trace is:[\s\S]*$/i, "");
}

async function describeFailure(response: Response, what: string): Promise<SpiraError> {
  if (response.status === 401 || response.status === 403) {
    return new SpiraError(
      `Spira refused access while ${what} (HTTP ${response.status}). Check ${SPIRA_ENV.username} and ${SPIRA_ENV.apiKey}, and that this user can access the project.`,
      502,
      response.status,
    );
  }
  if (response.status === 404) {
    return new SpiraError(`Spira could not find what was requested while ${what} (HTTP 404). Check the project and test set IDs in Settings.`, 502, 404);
  }
  const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();
  let detail: string;
  try {
    const body = JSON.parse(text) as { Message?: string; message?: string };
    detail = body.Message ?? body.message ?? text;
  } catch {
    detail = /^<(\?xml|!doctype|html)/i.test(text) ? htmlErrorText(text) : text;
  }
  detail = detail.slice(0, 300);
  return new SpiraError(`Spira returned HTTP ${response.status} while ${what}${detail ? `: ${detail}` : "."}`, 502, response.status);
}

/**
 * One Spira call. Reads are retried on network errors, timeouts, 429 and 5xx gateway
 * errors. Writes are never retried automatically: a lost response could hide a change
 * that already happened, so the caller re-reads membership instead.
 */
async function call(method: "GET" | "SEARCH" | "POST" | "PUT" | "DELETE", path: string, what: string, body?: unknown): Promise<unknown> {
  const config = requireConfig();
  // SEARCH is Spira's read-only POST …/search with an empty filter list.
  const write = method === "POST" || method === "PUT" || method === "DELETE";
  const attempts = write ? 1 : READ_ATTEMPTS;
  const payload = method === "SEARCH" ? "[]" : method === "POST" || method === "PUT" ? JSON.stringify(body ?? {}) : undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const last = attempt === attempts - 1;
    let response: Response;
    try {
      response = await fetch(`${config.restBase}/${path}`, {
        method: method === "SEARCH" ? "POST" : method,
        body: payload,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
          username: config.username,
          "api-key": config.apiKey,
        },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (!last) {
        await sleep(retryDelay(null, attempt));
        continue;
      }
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new SpiraError(`Spira did not answer within ${TIMEOUT_MS / 1000}s while ${what}.`, 504);
      }
      throw new SpiraError(`Could not reach Spira at ${new URL(config.restBase).host} while ${what}. Check ${SPIRA_ENV.baseUrl} and that Spira accepts connections from this server.`, 502);
    }
    if (RETRYABLE_STATUS.has(response.status) && !last) {
      await sleep(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok) throw await describeFailure(response, what);
    if (method === "DELETE") return null;
    const text = await response.text().catch(() => "");
    if (!text.trim() && method === "PUT") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new SpiraError(`Spira answered with something other than JSON while ${what}.`, 502);
    }
  }
  throw new SpiraError(`Spira could not be reached while ${what}.`, 502);
}

function parse<T extends z.ZodType>(schema: T, data: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SpiraError(`Spira returned an unexpected response while ${what} (${issue.path.join(".") || "root"}: ${issue.message}).`, 502);
  }
  return parsed.data;
}

const id = z.coerce.number().int().positive();

const testSetSchema = z.object({ TestSetId: id, Name: z.string().nullish(), ReleaseId: z.number().int().nullish() });

const mappingSchema = z.array(z.object({ TestSetTestCaseId: id, TestCaseId: id }));

const customPropertySchema = z.object({
  StringValue: z.string().nullish(),
  Definition: z.object({ Name: z.string().nullish() }).nullish(),
});

const testCaseSchema = z.array(
  z.object({
    TestCaseId: id,
    TestSetTestCaseId: id.nullish(),
    Name: z.string().nullish(),
    ExecutionStatusId: z.number().int().nullish(),
    ExecutionStatusName: z.string().nullish(),
    CustomProperties: z.array(customPropertySchema).nullish(),
  }),
);

const recordedRunSchema = z.object({ TestRunId: id });
const automatedRunSchema = z.object({
  TestRunId: id,
  TestCaseId: id.nullish(),
  TestSetId: z.number().int().nullish(),
  RunnerName: z.string().nullish(),
});
const testRunSchema = z.object({ TestRunId: id, TestCaseId: id.nullish(), TestRunTypeId: z.number().int().nullish() });
const runStepSchema = z
  .object({ TestStepId: z.number().int().nullish(), TestCaseId: z.number().int().nullish(), ActualResult: z.string().nullish() })
  .passthrough();
const manualRunSchema = z
  .object({ TestCaseId: id, ReleaseId: z.number().int().nullish(), TestRunSteps: z.array(runStepSchema).nullish() })
  .passthrough();
const TEST_RUN_TYPE = { manual: 1, automated: 2 } as const;

const projectListSchema = z.array(z.object({ ProjectId: id, Name: z.string().nullish(), Active: z.boolean().nullish() }));
const userSchema = z.object({ UserName: z.string().nullish(), FullName: z.string().nullish() });
const releaseSchema = z.object({
  ReleaseId: id,
  Name: z.string().nullish(),
  VersionNumber: z.string().nullish(),
  IndentLevel: z.string().nullish(),
  Active: z.boolean().nullish(),
  ReleaseTypeName: z.string().nullish(),
});
const RELEASE_LIMIT = 1_000;
const testSetListSchema = z.array(
  z.object({
    TestSetId: id,
    Name: z.string().nullish(),
    ReleaseId: z.number().int().nullish(),
    ReleaseVersionNumber: z.string().nullish(),
  }),
);

/** Page size for listing test sets, and a ceiling so a misbehaving server cannot loop us forever. */
const TEST_SET_PAGE = 500;
const TEST_SET_LIMIT = 5_000;

export interface SpiraTestSet {
  testSetId: number;
  name: string;
  releaseId: number | null;
}

/** One membership of a test case in a test set, with the details used for matching. */
export interface SpiraSetCase {
  testSetTestCaseId: number;
  testCaseId: number;
  name: string;
  executionStatus: string;
  /** Null when Spira did not report a status, which Spira treats as Not Run. */
  executionStatusId: number | null;
  executed: boolean;
  /** Text values of the test case's custom properties, searched for TC IDs. */
  customText: string[];
}

export { EXECUTION_STATUS };

export async function getTestSet(projectId: number, testSetId: number): Promise<SpiraTestSet> {
  const what = `reading test set ${testSetId}`;
  const raw = parse(testSetSchema, await call("GET", `projects/${projectId}/test-sets/${testSetId}`, what), what);
  return { testSetId: raw.TestSetId, name: raw.Name ?? `Test set ${testSetId}`, releaseId: raw.ReleaseId ?? null };
}

const testSetRecordSchema = z
  .object({
    TestSetId: id,
    Name: z.string().nullish(),
    ReleaseId: z.number().int().nullish(),
    TestSetStatusId: z.number().int().nullish(),
    OwnerId: z.number().int().nullish(),
    PlannedDate: z.unknown().optional(),
  })
  .passthrough();

/** A test set as Spira stores it, kept whole so it can be sent back with only a few fields changed. */
export interface TestSetRecord {
  raw: z.infer<typeof testSetRecordSchema>;
  testSetId: number;
  name: string;
  releaseId: number | null;
  statusId: number | null;
  ownerId: number | null;
  plannedDate: unknown;
}

export async function getTestSetRecord(projectId: number, testSetId: number): Promise<TestSetRecord> {
  const what = `reading test set ${testSetId}`;
  const raw = parse(testSetRecordSchema, await call("GET", `projects/${projectId}/test-sets/${testSetId}`, what), what);
  return {
    raw,
    testSetId: raw.TestSetId,
    name: raw.Name ?? `Test set ${testSetId}`,
    releaseId: raw.ReleaseId ?? null,
    statusId: raw.TestSetStatusId ?? null,
    ownerId: raw.OwnerId ?? null,
    plannedDate: raw.PlannedDate ?? null,
  };
}

/** Updates a test set: the record as read, with the given fields changed. A write: never retried. */
export async function updateTestSet(projectId: number, record: TestSetRecord, changes: Record<string, unknown>): Promise<void> {
  await call("PUT", `projects/${projectId}/test-sets`, `updating test set ${record.testSetId}`, { ...record.raw, ...changes });
}

/** Current memberships of a test set: test set test case ID → test case ID. */
export async function getMembership(projectId: number, testSetId: number): Promise<Map<number, number>> {
  const what = `reading the members of test set ${testSetId}`;
  const raw = parse(mappingSchema, await call("GET", `projects/${projectId}/test-sets/${testSetId}/test-case-mapping`, what), what);
  return new Map(raw.map((m) => [m.TestSetTestCaseId, m.TestCaseId]));
}

export async function getTestSetCases(projectId: number, testSetId: number): Promise<SpiraSetCase[]> {
  const what = `reading the test cases in test set ${testSetId}`;
  const [membership, rawCases] = await Promise.all([
    getMembership(projectId, testSetId),
    call("GET", `projects/${projectId}/test-sets/${testSetId}/test-cases`, what),
  ]);
  const cases = parse(testCaseSchema, rawCases, what);
  const byMembership = new Map(cases.filter((c) => c.TestSetTestCaseId).map((c) => [c.TestSetTestCaseId!, c]));
  const byTestCase = new Map(cases.map((c) => [c.TestCaseId, c]));

  return [...membership].map(([testSetTestCaseId, testCaseId]) => {
    const details = byMembership.get(testSetTestCaseId) ?? byTestCase.get(testCaseId);
    const statusId = details?.ExecutionStatusId ?? null;
    return {
      testSetTestCaseId,
      testCaseId,
      name: details?.Name?.trim() || `Test case TC:${testCaseId}`,
      executionStatus: details?.ExecutionStatusName ?? (statusId ? EXECUTION_STATUS_NAMES[statusId] : null) ?? "Not Run",
      executionStatusId: statusId,
      executed: statusId !== null && EXECUTED_STATUS_IDS.has(statusId),
      customText: (details?.CustomProperties ?? []).map((p) => p.StringValue ?? "").filter(Boolean),
    };
  });
}

export { RUNNER_NAME };

export interface TestRunRecord {
  testCaseId: number;
  testSetId: number;
  testSetTestCaseId: number;
  releaseId: number | null;
  executionStatusId: number;
  testName: string;
  message: string;
  details: string;
}

/**
 * Records one automated test run. This is a write: it is not retried, so a lost response
 * cannot create a duplicate; the caller re-reads status before any retry.
 */
export async function recordTestRun(projectId: number, run: TestRunRecord): Promise<number> {
  const now = `/Date(${Date.now()})/`;
  const what = `recording a result for test case ${run.testCaseId}`;
  const body = {
    TestRunFormatId: 1,
    TestRunTypeId: 2,
    RunnerName: RUNNER_NAME,
    RunnerTestName: run.testName.slice(0, 255),
    RunnerMessage: run.message.slice(0, 255),
    RunnerStackTrace: run.details,
    TestCaseId: run.testCaseId,
    TestSetId: run.testSetId,
    TestSetTestCaseId: run.testSetTestCaseId,
    ReleaseId: run.releaseId,
    ExecutionStatusId: run.executionStatusId,
    StartDate: now,
    EndDate: now,
  };
  const raw = parse(recordedRunSchema, await call("POST", `projects/${projectId}/test-runs/record`, what, body), what);
  return raw.TestRunId;
}

/** Spira's step fields are rich text: escape the tester's text and keep its line breaks. */
function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, "<br />");
}

/** A manual run Spira prepared for a test case and has not saved yet, with its steps. */
export interface ManualRunShell {
  raw: z.infer<typeof manualRunSchema>;
  steps: RunStepSlot[];
}

/**
 * Asks Spira for manual runs of several test cases in one call. Spira lays out the steps, including
 * those of called test cases, exactly as its own execution screen does. Nothing is saved until
 * saveManualRuns. Runs are returned in the order Spira gives them; match them by test case.
 */
export async function createManualRunShells(projectId: number, testCaseIds: number[], releaseId: number | null): Promise<ManualRunShell[]> {
  const what = `preparing test runs for ${testCaseIds.length === 1 ? `test case ${testCaseIds[0]}` : `${testCaseIds.length} test cases`}`;
  const query = releaseId ? `?release_id=${releaseId}` : "";
  const runs = parse(z.array(manualRunSchema), await call("POST", `projects/${projectId}/test-runs/create${query}`, what, testCaseIds), what);
  return runs.map((raw) => ({ raw, steps: (raw.TestRunSteps ?? []).map((s) => ({ testStepId: s.TestStepId ?? null, testCaseId: s.TestCaseId ?? null })) }));
}

export interface ManualRunInput {
  shell: ManualRunShell;
  testSetId: number;
  testSetTestCaseId: number;
  releaseId: number | null;
  executionStatusId: number;
  steps: Array<{ executionStatusId: number; actualResult: string }>;
}

/**
 * Saves prepared manual runs in one call, each with a status and actual result on every step.
 * A write: never retried. Returns the new test run IDs in the order given.
 */
export async function saveManualRuns(projectId: number, runs: ManualRunInput[]): Promise<number[]> {
  const now = `/Date(${Date.now()})/`;
  const what = runs.length === 1 ? `saving a test run for test case ${runs[0].shell.raw.TestCaseId}` : `saving ${runs.length} test runs`;
  const body = runs.map((run) => ({
    ...run.shell.raw,
    TestSetId: run.testSetId,
    TestSetTestCaseId: run.testSetTestCaseId,
    ReleaseId: run.releaseId ?? run.shell.raw.ReleaseId ?? null,
    ExecutionStatusId: run.executionStatusId,
    StartDate: now,
    EndDate: now,
    TestRunSteps: (run.shell.raw.TestRunSteps ?? []).map((step, i) => ({
      ...step,
      ExecutionStatusId: run.steps[i]?.executionStatusId ?? EXECUTION_STATUS.notRun,
      ActualResult: run.steps[i]?.actualResult ? textToHtml(run.steps[i].actualResult) : null,
    })),
  }));
  const saved = parse(
    z.array(z.object({ TestRunId: id, TestCaseId: id.nullish(), TestSetTestCaseId: z.number().int().nullish() })),
    await call("PUT", `projects/${projectId}/test-runs`, what, body),
    what,
  );
  if (saved.length !== runs.length) {
    throw new SpiraError(`Spira saved ${saved.length} of ${runs.length} test runs; check Spira again before retrying.`, 502);
  }
  // Match by membership when Spira echoes it, otherwise by position.
  return runs.map((run, i) => (saved.find((s) => s.TestSetTestCaseId === run.testSetTestCaseId) ?? saved[i]).TestRunId);
}

/**
 * Deletes a test run, but only one this app recorded for the expected test case: the run is read
 * first, and an automated run must carry this app's runner name, a manual run this app's signature.
 */
export async function deleteRecordedTestRun(projectId: number, testRunId: number, testCaseId: number): Promise<void> {
  const what = `reading test run ${testRunId}`;
  const notOurs = () => new SpiraError(`Test run ${testRunId} was not recorded by this app for TC${testCaseId}, so it was not deleted.`, 409);
  const run = parse(testRunSchema, await call("GET", `projects/${projectId}/test-runs/${testRunId}`, what), what);
  if (run.TestCaseId !== testCaseId) throw notOurs();
  if (run.TestRunTypeId === TEST_RUN_TYPE.manual) {
    const manual = parse(manualRunSchema, await call("GET", `projects/${projectId}/test-runs/${testRunId}/manual`, what), what);
    const signature = runSignature(RUNNER_NAME);
    if (!(manual.TestRunSteps ?? []).some((s) => s.ActualResult?.includes(signature))) throw notOurs();
  } else {
    const automated = parse(automatedRunSchema, await call("GET", `projects/${projectId}/test-runs/${testRunId}/automated`, what), what);
    if (automated.RunnerName !== RUNNER_NAME) throw notOurs();
  }
  await call("DELETE", `projects/${projectId}/test-runs/${testRunId}`, `deleting test run ${testRunId}`);
}

const projectSchema = z.object({ ProjectId: id, ProjectTemplateId: z.number().int().nullish() });
const optionListSchema = z.array(z.record(z.string(), z.unknown()));

/** The project's incident types, priorities and severities, for the defect form. Read-only. */
export async function getIncidentOptions(projectId: number): Promise<IncidentOptions> {
  const project = parse(projectSchema, await call("GET", `projects/${projectId}`, "reading the project"), "reading the project");
  const template = project.ProjectTemplateId;
  if (!template) return { types: [], priorities: [], severities: [], defaultTypeId: null, testCaseStatuses: [] };
  const read = async (path: string, key: string, what: string) => {
    const rows = parse(optionListSchema, await call("GET", `project-templates/${template}/${path}`, what), what);
    return rows
      .filter((r) => typeof r[key] === "number" && r.Active !== false && r.IsActive !== false)
      .map((r) => ({ id: r[key] as number, name: (typeof r.Name === "string" && r.Name.trim()) || `#${r[key]}`, isDefault: r.IsDefault === true }));
  };
  const [types, priorities, severities, testCaseStatuses] = await Promise.all([
    read("incidents/types", "IncidentTypeId", "reading the incident types"),
    read("incidents/priorities", "PriorityId", "reading the incident priorities"),
    read("incidents/severities", "SeverityId", "reading the incident severities"),
    // Only offered on a new test case; without it the project's default status is used.
    read("test-cases/statuses", "TestCaseStatusId", "reading the test case statuses").catch((error) => {
      if (error instanceof SpiraError) return [];
      throw error;
    }),
  ]);
  const strip = (list: Array<{ id: number; name: string }>) => list.map(({ id: optionId, name }) => ({ id: optionId, name }));
  return {
    types: strip(types),
    priorities: strip(priorities),
    severities: strip(severities),
    defaultTypeId: types.find((t) => t.isDefault)?.id ?? null,
    testCaseStatuses: strip(testCaseStatuses),
  };
}

const manualRunStepsSchema = z
  .object({
    TestRunId: id,
    TestCaseId: id,
    ReleaseId: z.number().int().nullish(),
    TestRunSteps: z
      .array(z.object({ TestRunStepId: z.number().int().nullish(), ExecutionStatusId: z.number().int().nullish(), ActualResult: z.string().nullish() }).passthrough())
      .nullish(),
  })
  .passthrough();

export interface RecordedRunSteps {
  testRunId: number;
  testCaseId: number;
  releaseId: number | null;
  /** True when the run carries this app's signature, so it was recorded here. */
  ours: boolean;
  /** Run step IDs of the steps marked Failed, in order. */
  failedStepIds: number[];
}

/** A saved manual run's steps, read back to find the run steps a defect links to. Read-only. */
export async function getRecordedRunSteps(projectId: number, testRunId: number): Promise<RecordedRunSteps> {
  const what = `reading test run ${testRunId}`;
  const run = parse(manualRunStepsSchema, await call("GET", `projects/${projectId}/test-runs/${testRunId}/manual`, what), what);
  const steps = run.TestRunSteps ?? [];
  const signature = runSignature(RUNNER_NAME);
  return {
    testRunId: run.TestRunId,
    testCaseId: run.TestCaseId,
    releaseId: run.ReleaseId ?? null,
    ours: steps.some((s) => s.ActualResult?.includes(signature)),
    failedStepIds: steps.filter((s) => s.ExecutionStatusId === EXECUTION_STATUS.failed && s.TestRunStepId).map((s) => s.TestRunStepId!),
  };
}

export interface IncidentInput {
  name: string;
  description: string;
  typeId: number | null;
  priorityId: number | null;
  severityId: number | null;
  releaseId: number | null;
  testRunStepIds: number[];
}

/** Creates an incident linked to failed run steps. A write: never retried, so a lost answer cannot create a duplicate. */
export async function createIncident(projectId: number, input: IncidentInput): Promise<number> {
  const what = "logging the defect as an incident";
  const body = {
    Name: input.name.slice(0, 255),
    Description: textToHtml(input.description),
    IncidentTypeId: input.typeId,
    PriorityId: input.priorityId,
    SeverityId: input.severityId,
    DetectedReleaseId: input.releaseId,
    TestRunStepIds: input.testRunStepIds,
  };
  const raw = parse(z.object({ IncidentId: id }).passthrough(), await call("POST", `projects/${projectId}/incidents`, what, body), what);
  return raw.IncidentId;
}

/** Deletes an incident, but only one this app logged: its description must carry the app's signature. */
export async function deleteLoggedIncident(projectId: number, incidentId: number): Promise<void> {
  const what = `reading incident ${incidentId}`;
  const raw = parse(z.object({ IncidentId: id, Description: z.string().nullish() }).passthrough(), await call("GET", `projects/${projectId}/incidents/${incidentId}`, what), what);
  if (!richText(raw.Description).includes(incidentSignature(RUNNER_NAME))) {
    throw new SpiraError(`Incident ${incidentId} was not logged by this app, so it was not deleted.`, 409);
  }
  await call("DELETE", `projects/${projectId}/incidents/${incidentId}`, `deleting incident ${incidentId}`);
}

/** The folder a test case is in (null for the root), so a new case can go next to its test set's cases. Read-only. */
export async function getTestCaseFolderId(projectId: number, testCaseId: number): Promise<number | null> {
  const what = `reading test case ${testCaseId}`;
  const raw = parse(z.object({ TestCaseFolderId: z.number().int().nullish() }).passthrough(), await call("GET", `projects/${projectId}/test-cases/${testCaseId}`, what), what);
  return raw.TestCaseFolderId && raw.TestCaseFolderId > 0 ? raw.TestCaseFolderId : null;
}

/** Creates a test case with the project's default type, and the chosen status or the default one. A write: never retried. */
export async function createTestCase(
  projectId: number,
  input: { name: string; description: string; folderId: number | null; statusId?: number | null },
): Promise<number> {
  const what = "creating the test case";
  const body = {
    Name: input.name.slice(0, 255),
    Description: textToHtml(input.description),
    TestCaseFolderId: input.folderId,
    // 0 lets Spira use the project's default status.
    TestCaseStatusId: input.statusId ?? 0,
    TestCaseTypeId: null,
  };
  const raw = parse(z.object({ TestCaseId: id }).passthrough(), await call("POST", `projects/${projectId}/test-cases`, what, body), what);
  return raw.TestCaseId;
}

/** Adds one step at the end of a test case. A write: never retried. */
export async function addTestStep(projectId: number, testCaseId: number, step: { position: number; description: string; expectedResult: string }): Promise<void> {
  await call("POST", `projects/${projectId}/test-cases/${testCaseId}/test-steps`, `adding step ${step.position} to test case ${testCaseId}`, {
    TestCaseId: testCaseId,
    Position: step.position,
    Description: textToHtml(step.description),
    ExpectedResult: textToHtml(step.expectedResult),
  });
}

/** Adds a test case to the end of a test set and returns the new membership. A write: never retried. */
export async function addToTestSet(projectId: number, testSetId: number, testCaseId: number): Promise<number> {
  const what = `adding test case ${testCaseId} to test set ${testSetId}`;
  const raw = await call("POST", `projects/${projectId}/test-sets/${testSetId}/test-case-mapping/${testCaseId}`, what, []);
  const answered = mappingSchema.safeParse(raw);
  const found = answered.success ? answered.data.find((m) => m.TestCaseId === testCaseId) : undefined;
  if (found) return found.TestSetTestCaseId;
  // Older servers answer without the mapping: read the membership instead.
  for (const [membership, caseId] of await getMembership(projectId, testSetId)) if (caseId === testCaseId) return membership;
  throw new SpiraError(`Spira did not add test case ${testCaseId} to test set ${testSetId}.`, 502);
}

/** Deletes a test case, but only one this app created for a defect: its description must carry the app's signature. */
export async function deleteCreatedTestCase(projectId: number, testCaseId: number): Promise<void> {
  const what = `reading test case ${testCaseId}`;
  const raw = parse(z.object({ TestCaseId: id, Description: z.string().nullish() }).passthrough(), await call("GET", `projects/${projectId}/test-cases/${testCaseId}`, what), what);
  if (!richText(raw.Description).includes(testCaseSignature(RUNNER_NAME))) {
    throw new SpiraError(`Test case ${testCaseId} was not created by this app, so it was not deleted.`, 409);
  }
  await call("DELETE", `projects/${projectId}/test-cases/${testCaseId}`, `deleting test case ${testCaseId}`);
}

/** Removes one membership. The test case itself is not deleted. */
export async function removeFromTestSet(projectId: number, testSetId: number, testSetTestCaseId: number): Promise<void> {
  await call(
    "DELETE",
    `projects/${projectId}/test-sets/${testSetId}/test-cases/${testSetTestCaseId}`,
    `removing membership ${testSetTestCaseId} from test set ${testSetId}`,
  );
}

const testCaseDetailSchema = z.object({
  TestCaseId: id,
  Name: z.string().nullish(),
  Description: z.string().nullish(),
  TestCasePriorityName: z.string().nullish(),
  TestCaseStatusName: z.string().nullish(),
  TestCaseTypeName: z.string().nullish(),
  AuthorName: z.string().nullish(),
  OwnerName: z.string().nullish(),
  ExecutionStatusId: z.number().int().nullish(),
  CustomProperties: z.array(customPropertySchema).nullish(),
});

const testStepSchema = z.array(
  z.object({
    TestStepId: z.number().int().nullish(),
    Position: z.number().int().nullish(),
    Description: z.string().nullish(),
    ExpectedResult: z.string().nullish(),
    SampleData: z.string().nullish(),
    Precondition: z.string().nullish(),
    LinkedTestCaseId: z.number().int().nullish(),
  }),
);

/** Linked test cases are followed this deep, and at most this many steps are returned. */
const LINKED_DEPTH = 2;
const MAX_STEPS = 300;

/**
 * A test case with its steps, for reading on the board. Read-only. Spira's HTML is reduced to
 * plain text with line breaks, so nothing from Spira is ever rendered as HTML in the browser.
 */
export async function getTestCaseDetail(projectId: number, testCaseId: number): Promise<TestCaseDetail> {
  let budget = MAX_STEPS;
  let truncated = false;
  const readSteps = async (caseId: number, depth: number, seen: Set<number>): Promise<TestCaseStep[]> => {
    const what = `reading the steps of test case ${caseId}`;
    const raw = parse(testStepSchema, await call("GET", `projects/${projectId}/test-cases/${caseId}/test-steps`, what), what);
    const steps: TestCaseStep[] = [];
    for (const [index, s] of raw.entries()) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      const linkedId = s.LinkedTestCaseId && s.LinkedTestCaseId > 0 ? s.LinkedTestCaseId : null;
      const step: TestCaseStep = {
        testStepId: s.TestStepId ?? null,
        position: s.Position ?? index + 1,
        description: richText(s.Description),
        expectedResult: richText(s.ExpectedResult),
        sampleData: richText(s.SampleData),
        precondition: richText(s.Precondition),
        linkedTestCaseId: linkedId,
        linkedName: null,
        linkedSteps: [],
      };
      if (linkedId && depth < LINKED_DEPTH && !seen.has(linkedId)) {
        const linkWhat = `reading linked test case ${linkedId}`;
        const linked = parse(testCaseDetailSchema, await call("GET", `projects/${projectId}/test-cases/${linkedId}`, linkWhat), linkWhat);
        step.linkedName = linked.Name?.trim() || null;
        step.linkedSteps = await readSteps(linkedId, depth + 1, new Set([...seen, linkedId]));
      }
      steps.push(step);
    }
    return steps.sort((a, b) => a.position - b.position);
  };

  const what = `reading test case ${testCaseId}`;
  const [raw, steps] = await Promise.all([
    call("GET", `projects/${projectId}/test-cases/${testCaseId}`, what).then((data) => parse(testCaseDetailSchema, data, what)),
    readSteps(testCaseId, 0, new Set([testCaseId])),
  ]);
  return {
    testCaseId: raw.TestCaseId,
    name: raw.Name?.trim() || `Test case TC:${testCaseId}`,
    description: richText(raw.Description),
    priority: raw.TestCasePriorityName?.trim() || null,
    status: raw.TestCaseStatusName?.trim() || null,
    type: raw.TestCaseTypeName?.trim() || null,
    author: raw.AuthorName?.trim() || null,
    owner: raw.OwnerName?.trim() || null,
    customFields: (raw.CustomProperties ?? [])
      .map((p) => ({ name: p.Definition?.Name?.trim() ?? "", value: richText(p.StringValue) }))
      .filter((f) => f.name && f.value),
    steps,
    truncated,
  };
}

/** Read-only check that the credentials work. Returns the projects this user can open. */
export async function checkConnection(): Promise<{ userName: string; projects: SpiraProject[] }> {
  const [user, projects] = await Promise.all([
    call("GET", "users", "reading the signed-in Spira user"),
    call("GET", "projects", "listing projects"),
  ]);
  const u = parse(userSchema, user, "reading the signed-in Spira user");
  const list = parse(projectListSchema, projects, "listing projects")
    .filter((p) => p.Active !== false)
    .map((p) => ({ projectId: p.ProjectId, name: p.Name?.trim() || `Project ${p.ProjectId}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { userName: u.FullName || u.UserName || "Unknown user", projects: list };
}

function toRelease(raw: z.infer<typeof releaseSchema>): SpiraRelease {
  const name = raw.Name?.trim() ?? "";
  const version = raw.VersionNumber?.trim() ?? "";
  return {
    releaseId: raw.ReleaseId,
    name,
    versionNumber: version,
    label: [version, name].filter(Boolean).join(" - ") || `Release ${raw.ReleaseId}`,
    depth: Math.max(0, Math.floor((raw.IndentLevel?.length ?? 3) / 3) - 1),
    active: raw.Active !== false,
    type: raw.ReleaseTypeName?.trim() || null,
  };
}

export async function getRelease(projectId: number, releaseId: number): Promise<SpiraRelease> {
  const what = `reading release ${releaseId}`;
  return toRelease(parse(releaseSchema, await call("GET", `projects/${projectId}/releases/${releaseId}`, what), what));
}

/**
 * Releases and their sprints/iterations in hierarchy order. The plain release list leaves
 * iterations out, so the read-only search is used first and the plain list is the fallback.
 */
export async function listReleases(projectId: number): Promise<SpiraRelease[]> {
  const what = `listing releases in project ${projectId}`;
  let raw: unknown;
  try {
    raw = await call("SEARCH", `projects/${projectId}/releases/search?start_row=1&number_rows=${RELEASE_LIMIT}`, what);
  } catch (error) {
    if (!(error instanceof SpiraError)) throw error;
    raw = await call("GET", `projects/${projectId}/releases?active_only=false`, what);
  }
  return parse(z.array(releaseSchema), raw, what)
    .sort((a, b) => (a.IndentLevel ?? "").localeCompare(b.IndentLevel ?? ""))
    .map(toRelease);
}

/** Every test set in the project, or only those planned for one release. Sorted by name. */
export async function listTestSets(projectId: number, releaseId: number | null): Promise<SpiraTestSetSummary[]> {
  const what = `listing test sets in project ${projectId}`;
  const found: SpiraTestSetSummary[] = [];
  for (let start = 1; start <= TEST_SET_LIMIT; start += TEST_SET_PAGE) {
    const query = new URLSearchParams({
      starting_row: String(start),
      number_of_rows: String(TEST_SET_PAGE),
      sort_field: "Name",
      sort_direction: "ASC",
    });
    if (releaseId !== null) query.set("release_id", String(releaseId));
    const page = parse(testSetListSchema, await call("GET", `projects/${projectId}/test-sets?${query}`, what), what);
    for (const t of page) {
      found.push({
        testSetId: t.TestSetId,
        name: t.Name?.trim() || `Test set ${t.TestSetId}`,
        releaseId: t.ReleaseId ?? null,
        releaseVersion: t.ReleaseVersionNumber?.trim() || null,
      });
    }
    if (page.length < TEST_SET_PAGE) break;
  }
  const unique = new Map(found.map((t) => [t.testSetId, t]));
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
