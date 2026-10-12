import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getTestSetResults, incidentsForTestCase, listIncidents, listReportTestSets, listTestSetFolders, spiraDate, SPIRA_ENV } = await import("@/lib/server/spira");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("report reads", () => {
  beforeEach(() => {
    vi.stubEnv(SPIRA_ENV.baseUrl, "https://example.spiraservice.net");
    vi.stubEnv(SPIRA_ENV.username, "tester");
    vi.stubEnv(SPIRA_ENV.apiKey, "not-a-real-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads Spira dates as UTC and ignores placeholders", () => {
    expect(spiraDate("2026-10-11T14:22:10.123")).toBe("2026-10-11T14:22:10.123Z");
    expect(spiraDate("/Date(1791763200000)/")).toBe(new Date(1791763200000).toISOString());
    expect(spiraDate("0001-01-01T00:00:00")).toBeNull();
    expect(spiraDate(null)).toBeNull();
  });

  it("lists test sets with folder, dates and Spira's counts, only with GET", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json([
        {
          TestSetId: 5,
          Name: " Cards - Android ",
          ReleaseId: 2,
          ReleaseVersionNumber: "1.0.0.0002",
          TestSetFolderId: 9,
          TestSetStatusName: "In Progress",
          OwnerName: "Ada",
          PlannedDate: "2026-09-22T00:00:00",
          ExecutionDate: null,
          CountPassed: 3,
          CountFailed: 1,
          CountNotRun: 2,
        },
      ]),
    );
    vi.stubGlobal("fetch", fetch);
    const [set] = await listReportTestSets(24, []);
    expect(set).toMatchObject({ testSetId: 5, name: "Cards - Android", folderId: 9, status: "In Progress", plannedDate: "2026-09-22T00:00:00.000Z", executionDate: null });
    expect(set.counts).toEqual({ passed: 3, failed: 1, caution: 0, blocked: 0, notRun: 2, notApplicable: 0 });
    expect(fetch.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true);
  });

  it("adds the test sets the project list leaves out by reading each folder", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const path = String(url);
      if (path.includes("/test-set-folders/1/test-sets?")) return json([{ TestSetId: 5, Name: "Cards - iOS", ReleaseId: 2 }]);
      if (path.includes("/test-set-folders/2/test-sets?")) return json({ Message: "Not found" }, 404);
      return json([{ TestSetId: 4, Name: "Accounts - iOS", ReleaseId: 1 }]);
    });
    vi.stubGlobal("fetch", fetch);
    const sets = await listReportTestSets(24, [
      { folderId: 1, parentId: null, name: "SIT Cycle 2" },
      { folderId: 2, parentId: 1, name: "API" },
    ]);
    expect(sets.map((s) => [s.testSetId, s.folderId, s.releaseId])).toEqual([
      [4, null, 1],
      [5, 1, 2],
    ]);
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("reads folders and a test set's results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const path = String(url);
        if (path.endsWith("/test-set-folders")) return json([{ TestSetFolderId: 1, ParentTestSetFolderId: null, Name: "SIT Cycle 2" }, { TestSetFolderId: 2, ParentTestSetFolderId: 1, Name: "API" }]);
        if (path.endsWith("/test-sets/5/test-cases")) return json([{ TestCaseId: 7, TestSetTestCaseId: 70, Name: "Login", ExecutionStatusId: 2, ExecutionDate: "2026-10-11T10:00:00" }, { TestCaseId: 8, ExecutionStatusId: 0 }]);
        return json({}, 404);
      }),
    );
    expect(await listTestSetFolders(24)).toEqual([
      { folderId: 1, parentId: null, name: "SIT Cycle 2" },
      { folderId: 2, parentId: 1, name: "API" },
    ]);
    expect(await getTestSetResults(24, 5)).toEqual([
      { testSetTestCaseId: 70, testCaseId: 7, name: "Login", statusId: 2, executionDate: "2026-10-11T10:00:00.000Z", priority: null },
      { testSetTestCaseId: null, testCaseId: 8, name: "Test case TC:8", statusId: null, executionDate: null, priority: null },
    ]);
  });

  it("pages through incidents and falls back to the recent list on older servers", async () => {
    const page = (from: number, size: number) => Array.from({ length: size }, (_, i) => ({ IncidentId: from + i, Name: `D${from + i}`, IncidentStatusOpenStatus: true }));
    const paged = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes("start_row=1&")) return json(page(1, 500));
      if (path.includes("start_row=501&")) return json(page(501, 3));
      return json({}, 404);
    });
    vi.stubGlobal("fetch", paged);
    const all = await listIncidents(24);
    expect(all.complete).toBe(true);
    expect(all.incidents).toHaveLength(503);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const path = String(url);
        if (path.includes("/incidents/search")) return json({ Message: "Not supported" }, 400);
        if (path.endsWith("/incidents")) return json([{ IncidentId: 9, Name: "Old", IncidentStatusName: "Closed", ClosedDate: "2026-10-01T00:00:00" }]);
        return json({}, 404);
      }),
    );
    const fallback = await listIncidents(24);
    expect(fallback).toMatchObject({ complete: true, incidents: [{ incidentId: 9, open: false, closedAt: "2026-10-01T00:00:00.000Z" }] });
  });

  it("reads the incidents linked to a test case, open or closed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json([{ IncidentId: 258, Name: "MTN missing", IncidentStatusName: "New", IncidentStatusOpenStatus: true, SeverityName: "3 - Medium", DetectedReleaseId: 2 }]),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await incidentsForTestCase(24, 6579)).toMatchObject([{ incidentId: 258, open: true, severity: "3 - Medium", detectedReleaseId: 2 }]);
    expect(String(fetch.mock.calls[0][0])).toContain("/incidents/search-by-test-case/6579?open_only=false");
  });
});
