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
    );
  }
  if (response.status === 404) {
    return new SpiraError(`Spira could not find what was requested while ${what} (HTTP 404). Check the project and test set IDs in Settings.`, 502);
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
  return new SpiraError(`Spira returned HTTP ${response.status} while ${what}${detail ? `: ${detail}` : "."}`, 502);
}

/**
 * One Spira call. Reads are retried on network errors, timeouts, 429 and 5xx gateway
 * errors. Writes are never retried automatically: a lost response could hide a change
 * that already happened, so the caller re-reads membership instead.
 */
async function call(method: "GET" | "DELETE", path: string, what: string): Promise<unknown> {
  const config = requireConfig();
  const attempts = method === "GET" ? READ_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const last = attempt === attempts - 1;
    let response: Response;
    try {
      response = await fetch(`${config.restBase}/${path}`, {
        method,
        headers: { Accept: "application/json", username: config.username, "api-key": config.apiKey },
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

const projectListSchema = z.array(z.object({ ProjectId: id, Name: z.string().nullish(), Active: z.boolean().nullish() }));
const userSchema = z.object({ UserName: z.string().nullish(), FullName: z.string().nullish() });
const releaseSchema = z.object({ ReleaseId: id, Name: z.string().nullish(), VersionNumber: z.string().nullish() });
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
  executed: boolean;
  /** Text values of the test case's custom properties, searched for TC IDs. */
  customText: string[];
}

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
      executed: statusId !== null && EXECUTED_STATUS_IDS.has(statusId),
      customText: (details?.CustomProperties ?? []).map((p) => p.StringValue ?? "").filter(Boolean),
    };
  });
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

export async function getRelease(projectId: number, releaseId: number): Promise<SpiraRelease> {
  const what = `reading release ${releaseId}`;
  const raw = parse(releaseSchema, await call("GET", `projects/${projectId}/releases/${releaseId}`, what), what);
  const name = raw.Name?.trim() ?? "";
  const version = raw.VersionNumber?.trim() ?? "";
  return {
    releaseId: raw.ReleaseId,
    name,
    versionNumber: version,
    label: [version, name].filter(Boolean).join(" - ") || `Release ${releaseId}`,
  };
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
