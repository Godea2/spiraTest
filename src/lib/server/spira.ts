import "server-only";
import { z } from "zod";
import type { SpiraProject, SpiraRelease, SpiraStatus, SpiraTestSetSummary } from "@/lib/domain/types";

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

/** Spira execution statuses that mean a run was recorded (Failed, Passed, Blocked, Caution). */
const EXECUTED_STATUS_IDS = new Set([1, 2, 5, 6]);
const EXECUTION_STATUS_NAMES: Record<number, string> = {
  1: "Failed",
  2: "Passed",
  3: "Not Run",
  4: "N/A",
  5: "Blocked",
  6: "Caution",
};

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

export type BaseUrlCheck = { ok: true; restBase: string; host: string } | { ok: false; error: string };

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
  return { ok: true, restBase: `${url.origin}${path}${REST_PATH}`, host: url.host };
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
    detail = text;
  }
  detail = detail.slice(0, 300);
  return new SpiraError(`Spira returned HTTP ${response.status} while ${what}${detail ? `: ${detail}` : "."}`, 502, response.status);
}

/**
 * One Spira call. Reads are retried on network errors, timeouts, 429 and 5xx gateway
 * errors. Writes are never retried automatically: a lost response could hide a change
 * that already happened, so the caller re-reads membership instead.
 */
async function call(method: "GET" | "SEARCH" | "POST" | "DELETE", path: string, what: string, body?: unknown): Promise<unknown> {
  const config = requireConfig();
  // SEARCH is Spira's read-only POST …/search with an empty filter list.
  const write = method === "POST" || method === "DELETE";
  const attempts = write ? 1 : READ_ATTEMPTS;
  const payload = method === "SEARCH" ? "[]" : method === "POST" ? JSON.stringify(body ?? {}) : undefined;
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
    try {
      return await response.json();
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

/** Spira's execution status IDs. */
export const EXECUTION_STATUS = { failed: 1, passed: 2, notRun: 3, notApplicable: 4, blocked: 5, caution: 6 } as const;

export async function getTestSet(projectId: number, testSetId: number): Promise<SpiraTestSet> {
  const what = `reading test set ${testSetId}`;
  const raw = parse(testSetSchema, await call("GET", `projects/${projectId}/test-sets/${testSetId}`, what), what);
  return { testSetId: raw.TestSetId, name: raw.Name ?? `Test set ${testSetId}`, releaseId: raw.ReleaseId ?? null };
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

/** Name the app records as the runner, and checks before deleting a run on undo. */
export const RUNNER_NAME = "Spira Test Set Reconciler";

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

/**
 * Deletes a test run, but only one this app recorded for the expected test case:
 * the run is read first and its runner name and test case are checked.
 */
export async function deleteRecordedTestRun(projectId: number, testRunId: number, testCaseId: number): Promise<void> {
  const what = `reading test run ${testRunId}`;
  const run = parse(automatedRunSchema, await call("GET", `projects/${projectId}/test-runs/${testRunId}/automated`, what), what);
  if (run.RunnerName !== RUNNER_NAME || run.TestCaseId !== testCaseId) {
    throw new SpiraError(`Test run ${testRunId} was not recorded by this app for TC${testCaseId}, so it was not deleted.`, 409);
  }
  await call("DELETE", `projects/${projectId}/test-runs/${testRunId}`, `deleting test run ${testRunId}`);
}

/** Removes one membership. The test case itself is not deleted. */
export async function removeFromTestSet(projectId: number, testSetId: number, testSetTestCaseId: number): Promise<void> {
  await call(
    "DELETE",
    `projects/${projectId}/test-sets/${testSetId}/test-cases/${testSetTestCaseId}`,
    `removing membership ${testSetTestCaseId} from test set ${testSetId}`,
  );
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
