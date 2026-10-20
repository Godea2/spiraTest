import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getIncidentOptions, SPIRA_ENV } = await import("@/lib/server/spira");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function spiraAnswers(statuses: () => Response, incidentStatuses?: () => Response) {
  return vi.fn(async (url: string | URL) => {
    const path = String(url);
    if (path.endsWith("/projects/24")) return json({ ProjectId: 24, ProjectTemplateId: 7 });
    if (path.includes("/incidents/types")) return json([{ IncidentTypeId: 1, Name: "Bug", IsDefault: true }]);
    if (path.includes("/incidents/priorities")) return json([{ PriorityId: 2, Name: "1 - Critical" }]);
    if (path.includes("/incidents/severities")) return json([{ SeverityId: 3, Name: "1 - Critical" }]);
    if (path.includes("/incidents/statuses")) {
      return incidentStatuses
        ? incidentStatuses()
        : json([
            { IncidentStatusId: 1, Name: "New", Open: true },
            { IncidentStatusId: 2, Name: "Closed", Open: false },
            { IncidentStatusId: 9, Name: "Retired", Active: false, Open: false },
          ]);
    }
    if (path.includes("/test-cases/statuses")) return statuses();
    return json({}, 404);
  });
}

describe("getIncidentOptions", () => {
  beforeEach(() => {
    vi.stubEnv(SPIRA_ENV.baseUrl, "https://example.spiraservice.net");
    vi.stubEnv(SPIRA_ENV.username, "tester");
    vi.stubEnv(SPIRA_ENV.apiKey, "not-a-real-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("includes the project's active test case statuses", async () => {
    vi.stubGlobal(
      "fetch",
      spiraAnswers(() =>
        json([
          { TestCaseStatusId: 1, Name: "Draft" },
          { TestCaseStatusId: 4, Name: "Ready for Test" },
          { TestCaseStatusId: 9, Name: "Obsolete", Active: false },
        ]),
      ),
    );
    const options = await getIncidentOptions(24);
    expect(options.testCaseStatuses).toEqual([
      { id: 1, name: "Draft" },
      { id: 4, name: "Ready for Test" },
    ]);
    expect(options.statuses).toEqual([
      { id: 1, name: "New", open: true },
      { id: 2, name: "Closed", open: false },
    ]);
    expect(options.defaultTypeId).toBe(1);
  });

  it("still returns the incident lists when the test case statuses cannot be read", async () => {
    vi.stubGlobal("fetch", spiraAnswers(() => json({ Message: "Not allowed" }, 403)));
    const options = await getIncidentOptions(24);
    expect(options.testCaseStatuses).toEqual([]);
    expect(options.types).toEqual([{ id: 1, name: "Bug" }]);
    expect(options.statuses).toHaveLength(2);
  });

  it("omits incident statuses when Spira refuses them", async () => {
    vi.stubGlobal(
      "fetch",
      spiraAnswers(
        () => json([]),
        () => json({ Message: "Not allowed" }, 403),
      ),
    );
    const options = await getIncidentOptions(24);
    expect(options.statuses).toEqual([]);
    expect(options.types).toEqual([{ id: 1, name: "Bug" }]);
  });
});
