import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkConnection,
  getMembership,
  getTestSetCases,
  removeFromTestSet,
  spiraStatus,
  validateSpiraBaseUrl,
} from "@/lib/server/spira";
import { FakeSpira, SPIRA_TEST_ENV } from "./fake-spira";

let spira: FakeSpira;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(process.env, SPIRA_TEST_ENV);
  spira = new FakeSpira();
  spira.addTestSet(125, "Onboarding-IOS", [
    { testCaseId: 3519, name: "TC-ONB-001 Sign up", executionStatusId: 2, customText: ["EXT-1"] },
    { testCaseId: 3520, name: "Legacy check", executionStatusId: 3 },
  ]);
  fetchMock = vi.fn(spira.handle);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const key of Object.keys(SPIRA_TEST_ENV)) delete process.env[key];
});

describe("Spira configuration", () => {
  it("accepts the site URL or the full REST URL", () => {
    expect(validateSpiraBaseUrl("https://acme.spiraservice.net/")).toMatchObject({
      ok: true,
      restBase: "https://acme.spiraservice.net/Services/v7_0/RestService.svc",
    });
    expect(validateSpiraBaseUrl("https://acme.example.com/spira/Services/v7_0/RestService.svc")).toMatchObject({
      ok: true,
      restBase: "https://acme.example.com/spira/Services/v7_0/RestService.svc",
    });
  });

  it("rejects insecure or credential-bearing URLs", () => {
    expect(validateSpiraBaseUrl("http://acme.spiraservice.net").ok).toBe(false);
    expect(validateSpiraBaseUrl("https://user:pass@acme.spiraservice.net").ok).toBe(false);
    expect(validateSpiraBaseUrl("https://acme.spiraservice.net/?api-key=x").ok).toBe(false);
  });

  it("reports what is missing without exposing the API key", () => {
    expect(JSON.stringify(spiraStatus())).not.toContain(SPIRA_TEST_ENV.SPIRA_API_KEY);
    expect(spiraStatus()).toMatchObject({ configured: true, host: "spira.test.example", username: "reconciler-bot", apiKeyConfigured: true });
    delete process.env.SPIRA_API_KEY;
    expect(spiraStatus()).toMatchObject({ configured: false, problems: ["SPIRA_API_KEY is not set."] });
  });
});

describe("Spira client", () => {
  it("authenticates with headers, never with the URL", async () => {
    await getMembership(24, 125);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("api-key");
    expect(url).not.toContain(SPIRA_TEST_ENV.SPIRA_API_KEY);
    expect(init.headers).toMatchObject({ username: "reconciler-bot", "api-key": SPIRA_TEST_ENV.SPIRA_API_KEY, Accept: "application/json" });
  });

  it("joins membership with test case details", async () => {
    const cases = await getTestSetCases(24, 125);
    expect(cases).toEqual([
      { testSetTestCaseId: 12318, testCaseId: 3519, name: "TC-ONB-001 Sign up", executionStatus: "Passed", executed: true, customText: ["EXT-1"] },
      { testSetTestCaseId: 12319, testCaseId: 3520, name: "Legacy check", executionStatus: "Not Run", executed: false, customText: [] },
    ]);
  });

  it("retries reads on temporary Spira errors", async () => {
    spira.flakyReads = [503, 429];
    expect([...(await getMembership(24, 125)).keys()]).toEqual([12318, 12319]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries a removal automatically", async () => {
    spira.failNextDelete.add(12319);
    await expect(removeFromTestSet(24, 125, 12319)).rejects.toThrow(/HTTP 500.*Database timeout/);
    expect(spira.deletes).toEqual([12319]);
    expect(spira.members(125)).toEqual([12318, 12319]);
  });

  it("removes only the requested membership", async () => {
    await removeFromTestSet(24, 125, 12319);
    expect(spira.calls.at(-1)).toEqual({ method: "DELETE", path: "projects/24/test-sets/125/test-cases/12319" });
    expect(spira.members(125)).toEqual([12318]);
  });

  it("explains rejected credentials", async () => {
    process.env.SPIRA_API_KEY = "{WRONG}";
    await expect(getMembership(24, 125)).rejects.toThrow(/refused access.*SPIRA_API_KEY/);
  });

  it("explains an unknown project or test set", async () => {
    await expect(getMembership(24, 999)).rejects.toThrow(/HTTP 404/);
  });

  it("refuses to call Spira when it is not configured", async () => {
    delete process.env.SPIRA_BASE_URL;
    await expect(getMembership(24, 125)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the connection with read-only calls", async () => {
    expect(await checkConnection(24)).toEqual({ userName: "Reconciler Bot", projectName: "Mobile Banking" });
    expect(spira.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
