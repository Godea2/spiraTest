// In-memory stand-in for the Spira REST API, used only by tests so nothing ever
// reaches a real Spira instance.

export const SPIRA_TEST_ENV = {
  SPIRA_BASE_URL: "https://spira.test.example",
  SPIRA_USERNAME: "reconciler-bot",
  SPIRA_API_KEY: "{TEST-API-KEY}",
};

const REST = "https://spira.test.example/Services/v7_0/RestService.svc/";

export interface FakeCase {
  testCaseId: number;
  name: string;
  executionStatusId?: number | null;
  customText?: string[];
}

interface FakeSet {
  name: string;
  releaseId: number | null;
  members: Array<{ testSetTestCaseId: number; testCaseId: number }>;
}

export interface SpiraCall {
  method: string;
  path: string;
}

export class FakeSpira {
  projectId = 24;
  testCases = new Map<number, FakeCase>();
  testSets = new Map<number, FakeSet>();
  /** Membership IDs whose next DELETE fails with HTTP 500. */
  failNextDelete = new Set<number>();
  /** Status to return for the next N reads, to exercise retries. */
  flakyReads: number[] = [];
  calls: SpiraCall[] = [];
  private nextMembershipId = 12_318;

  addTestSet(testSetId: number, name: string, cases: FakeCase[], releaseId: number | null = 157) {
    const members = cases.map((c) => {
      this.testCases.set(c.testCaseId, c);
      return { testSetTestCaseId: this.nextMembershipId++, testCaseId: c.testCaseId };
    });
    this.testSets.set(testSetId, { name, releaseId, members });
    return members;
  }

  addMember(testSetId: number, testCase: FakeCase) {
    this.testCases.set(testCase.testCaseId, testCase);
    const member = { testSetTestCaseId: this.nextMembershipId++, testCaseId: testCase.testCaseId };
    this.testSets.get(testSetId)!.members.push(member);
    return member;
  }

  members(testSetId: number): number[] {
    return this.testSets.get(testSetId)!.members.map((m) => m.testSetTestCaseId);
  }

  get deletes(): number[] {
    return this.calls.filter((c) => c.method === "DELETE").map((c) => Number(c.path.split("/").pop()));
  }

  handle = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(REST)) throw new TypeError(`Unexpected request to ${url}`);
    const method = init.method ?? "GET";
    const path = url.slice(REST.length);
    this.calls.push({ method, path });
    const headers = init.headers as Record<string, string>;
    if (headers.username !== SPIRA_TEST_ENV.SPIRA_USERNAME || headers["api-key"] !== SPIRA_TEST_ENV.SPIRA_API_KEY) {
      return Response.json({ Message: "Unauthorized" }, { status: 401 });
    }
    if (method === "GET" && this.flakyReads.length) {
      return new Response("Service Unavailable", { status: this.flakyReads.shift()! });
    }

    const parts = path.split("/");
    if (method === "GET" && path === "users") return Response.json({ UserName: SPIRA_TEST_ENV.SPIRA_USERNAME, FullName: "Reconciler Bot" });
    if (parts[0] !== "projects" || Number(parts[1]) !== this.projectId) return Response.json({ Message: "Not found" }, { status: 404 });
    if (method === "GET" && parts.length === 2) return Response.json({ ProjectId: this.projectId, Name: "Mobile Banking" });

    const set = this.testSets.get(Number(parts[3]));
    if (parts[2] !== "test-sets" || !set) return Response.json({ Message: "Test set not found" }, { status: 404 });

    if (method === "GET" && parts.length === 4) {
      return Response.json({ TestSetId: Number(parts[3]), Name: set.name, ReleaseId: set.releaseId });
    }
    if (method === "GET" && parts[4] === "test-case-mapping") {
      return Response.json(set.members.map((m) => ({ TestSetTestCaseId: m.testSetTestCaseId, TestSetId: Number(parts[3]), TestCaseId: m.testCaseId })));
    }
    if (method === "GET" && parts[4] === "test-cases") {
      return Response.json(
        set.members.map((m) => {
          const c = this.testCases.get(m.testCaseId)!;
          return {
            TestCaseId: c.testCaseId,
            Name: c.name,
            ExecutionStatusId: c.executionStatusId ?? 3,
            CustomProperties: (c.customText ?? []).map((text) => ({ StringValue: text, Definition: { Name: "External ID" } })),
          };
        }),
      );
    }
    if (method === "DELETE" && parts[4] === "test-cases" && parts[5]) {
      const id = Number(parts[5]);
      if (this.failNextDelete.delete(id)) return Response.json({ Message: "Database timeout" }, { status: 500 });
      const index = set.members.findIndex((m) => m.testSetTestCaseId === id);
      if (index < 0) return Response.json({ Message: "Not found" }, { status: 404 });
      set.members.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return Response.json({ Message: `Unhandled ${method} ${path}` }, { status: 404 });
  };
}
