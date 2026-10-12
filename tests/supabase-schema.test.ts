import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyApplyState } from "@/lib/domain/draft-ops";
import type { Card, DefectRecord, Draft } from "@/lib/domain/types";
import { listEntries, readItems, writeItems } from "@/lib/server/store";

/** supabase/schema.sql run in a real Postgres (PGlite), with the app's REST calls answered from it. */

const schema = readFileSync(path.resolve(import.meta.dirname, "../supabase/schema.sql"), "utf8");
let db: PGlite;

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;");
  await db.exec(schema);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(
    "truncate settings, module_mappings, drafts, test_runs, defects, defect_cases, activity_log, report_setups, report_history, app_store, sync_keys",
  );
  process.env.SUPABASE_URL = "https://db.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const route = url.replace("https://db.test/rest/v1/", "");
    const body = init.body ? JSON.parse(init.body as string) : null;
    try {
      if (route.startsWith("sync_keys?")) {
        const q = new URLSearchParams(route.split("?")[1]);
        return Response.json(await rows("select key, updated_at, deleted, size from sync_keys order by key limit $1 offset $2", [Number(q.get("limit")), Number(q.get("offset"))]));
      }
      if (route === "rpc/store_write") {
        await db.query("select store_write($1::jsonb, $2::timestamptz)", [JSON.stringify(body.items), body.written_at]);
        return new Response(null, { status: 204 });
      }
      if (route === "rpc/store_read") return Response.json(await rows("select * from store_read($1::text[])", [body.keys]));
      return new Response("unknown route", { status: 404 });
    } catch (error) {
      return new Response(String(error), { status: 400 });
    }
  });
});

const card = (membership: number, testCaseId: number, suggestion: Card["suggestion"], executionStatus = "Not Run"): Card => ({
  key: `126:${membership}`,
  testSetId: 126,
  testCaseId,
  testSetTestCaseId: membership,
  name: `Case ${testCaseId}`,
  tcId: null,
  executionStatus,
  executed: executionStatus !== "Not Run",
  suggestion,
  reason: "",
});

function draft(extra: Partial<Draft> = {}): Draft {
  return {
    id: "d0000001-aaaa-bbbb-cccc-000000000001",
    name: "Payments – SIT Cycle 2",
    module: "Payments",
    projectId: 24,
    releaseId: 157,
    releaseLabel: "1.0.0.0002 - Sprint3",
    status: "draft",
    createdAt: "2026-10-10T08:00:00.000Z",
    updatedAt: "2026-10-12T09:30:00.000Z",
    source: { fileName: "scope.xlsx", inScopeSheet: "In Scope", needsConfirmationSheet: null },
    rows: [],
    testSetIds: [126],
    testSetRefs: [{ testSetId: 126, testSetName: "Payments-IOS", platform: "iOS" }],
    testSets: [
      {
        testSetId: 126,
        testSetName: "Payments-IOS",
        platform: "iOS",
        comparedAt: "2026-10-12T09:00:00.000Z",
        cards: [card(1, 1001, "inScope", "Passed"), card(2, 1002, "inScope"), card(3, 1003, "blocked"), card(4, 1004, "outOfScope")],
        missingFromSpira: [],
        baselineMembership: [1, 2, 3, 4],
        seal: "sealed",
      },
    ] as unknown as Draft["testSets"],
    compareErrors: {},
    decisions: {},
    history: [],
    apply: { ...emptyApplyState(), signOffRuns: [{ testSetId: 126, testCaseId: 1001, testSetTestCaseId: 1, status: "Passed" as never, testRunId: 9001, at: "2026-10-12T10:00:00.000Z" }] },
    execution: {
      runs: [
        { testSetId: 126, testCaseId: 1002, testSetTestCaseId: 2, status: "Failed" as never, testRunId: 9002, at: "2026-10-12T11:00:00.000Z", tester: "Daniel", comment: "Crashes on submit" },
      ],
      progress: {},
      spira: {},
      checkedAt: null,
    },
    ...extra,
  };
}

const defect = (id: string, at: string): DefectRecord => ({
  id,
  projectId: 24,
  at,
  title: `Defect ${id}`,
  description: "Payment fails",
  tester: "Daniel",
  report: "Steps…",
  incidentId: 258,
  linkedSteps: 1,
  cases: [{ draftId: "d1", module: "Payments", testSetId: 126, testCaseId: 1002, testSetTestCaseId: 2, name: "Case 1002", testRunId: 9002, stepLabel: "3", from: "inScope" }],
});

const activity = (id: string, at: string) => ({ id, at, type: "draft.created", message: `Entry ${id}`, draftId: null, module: "Payments", details: { n: 1 } });

describe("supabase/schema.sql", () => {
  it("creates the tables, and running it again is safe", async () => {
    await db.exec(schema);
    const tables = (await rows<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by 1")).map((t) => t.tablename);
    expect(tables).toEqual(["activity_log", "app_store", "defect_cases", "defects", "drafts", "module_mappings", "report_history", "report_setups", "settings", "sync_keys", "test_runs"]);
  });

  it("gives Supabase's public keys no access to tables or functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query("select * from drafts")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from store_read(array['settings'])")).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    await expect(db.query("select * from store_read(array['settings'])")).resolves.toBeDefined();
    await db.exec("reset role");
  });
});

describe("saving to Supabase tables", () => {
  it("keeps a draft exactly, with its board counts and every recorded test run as rows", async () => {
    const d = draft();
    await writeItems([{ key: `draft:${d.id}`, value: d }], new Date("2026-10-12T12:00:00Z"));
    const [read] = await readItems([`draft:${d.id}`]);
    expect(read).toEqual({ key: `draft:${d.id}`, value: d, updatedAt: "2026-10-12T12:00:00.000Z", deleted: false });

    const [row] = await rows("select * from drafts");
    expect(row).toMatchObject({
      project_id: 24,
      module: "Payments",
      status: "draft",
      stage: "review",
      release_id: 157,
      workbook: "scope.xlsx",
      test_set_ids: [126],
      platforms: ["iOS"],
      total_cases: 4,
      in_scope: 2,
      blocked: 1,
      out_of_scope: 1,
      deleted_at: null,
    });
    const runs = await rows<{ test_run_id: unknown; status: string; tester: string | null; recorded_by: string }>(
      "select test_run_id, status, tester, recorded_by from test_runs order by test_run_id",
    );
    expect(runs.map((r) => [Number(r.test_run_id), r.status, r.tester, r.recorded_by])).toEqual([
      [9001, "Passed", null, "sign-off"],
      [9002, "Failed", "Daniel", "execution"],
    ]);
  });

  it("replaces a draft's runs when it changes, and keeps a deleted draft on record", async () => {
    const d = draft();
    await writeItems([{ key: `draft:${d.id}`, value: d }]);
    await writeItems([{ key: `draft:${d.id}`, value: { ...d, execution: { ...d.execution!, runs: [] } } }]);
    expect(await rows("select * from test_runs")).toHaveLength(1);

    await writeItems([{ key: `draft:${d.id}`, value: null }], new Date("2026-10-13T00:00:00Z"));
    expect(await readItems([`draft:${d.id}`])).toEqual([{ key: `draft:${d.id}`, value: null, updatedAt: "2026-10-13T00:00:00.000Z", deleted: true }]);
    const [kept] = await rows<{ deleted_at: Date }>("select deleted_at from drafts");
    expect(kept.deleted_at.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(await listEntries()).toEqual([{ key: `draft:${d.id}`, updatedAt: "2026-10-13T00:00:00.000Z", deleted: true, size: 0 }]);
  });

  it("keeps a draft whose fields have unexpected types instead of failing the save", async () => {
    const odd = { id: "odd00001", projectId: "twenty-four", name: 5, testSetIds: ["x", 3], createdAt: "not a date" };
    await writeItems([{ key: "draft:odd00001", value: odd }]);
    expect((await readItems(["draft:odd00001"]))[0].value).toEqual(odd);
    expect(await rows("select project_id, name, test_set_ids, total_cases from drafts")).toEqual([{ project_id: 0, name: "", test_set_ids: [3], total_cases: null }]);
  });

  it("stores defects with their cases, and keeps a removed defect on record", async () => {
    await writeItems([{ key: "defects", value: [defect("a", "2026-10-11T09:00:00.000Z"), defect("b", "2026-10-11T10:00:00.000Z")] }]);
    expect(await rows("select id, incident_id, case_count from defects order by id")).toEqual([
      { id: "a", incident_id: 258, case_count: 1 },
      { id: "b", incident_id: 258, case_count: 1 },
    ]);
    expect(await rows("select defect_id, test_run_id, step_label, moved_from from defect_cases order by defect_id")).toEqual([
      { defect_id: "a", test_run_id: 9002, step_label: "3", moved_from: "inScope" },
      { defect_id: "b", test_run_id: 9002, step_label: "3", moved_from: "inScope" },
    ]);

    await writeItems([{ key: "defects", value: [defect("b", "2026-10-11T10:00:00.000Z")] }]);
    expect((await readItems(["defects"]))[0].value).toEqual([defect("b", "2026-10-11T10:00:00.000Z")]);
    expect(await rows("select id, deleted_at is not null as removed from defects order by id")).toEqual([
      { id: "a", removed: true },
      { id: "b", removed: false },
    ]);
  });

  it("adds activity from every browser to one log, newest first", async () => {
    const [first] = await writeItems([{ key: "activity", value: [activity("b", "2026-10-12T09:00:00.000Z"), activity("a", "2026-10-12T08:00:00.000Z")] }]);
    expect(first.merged).toBe(true);
    await writeItems([{ key: "activity", value: [activity("c", "2026-10-12T10:00:00.000Z")] }]);
    expect(((await readItems(["activity"]))[0].value as Array<{ id: string }>).map((e) => e.id)).toEqual(["c", "b", "a"]);
    expect(await rows("select id, type, module, details from activity_log where id = 'c'")).toEqual([{ id: "c", type: "draft.created", module: "Payments", details: { n: 1 } }]);
  });

  it("stores settings with module mappings, report setups and history, and other items", async () => {
    const settings = {
      projectId: 24,
      releaseId: 157,
      releaseLabel: "1.0.0.0002 - Sprint3",
      planReleaseId: 156,
      mappings: [{ id: "m1", module: "Payments", testSetId: 126, testSetName: "Payments-IOS", platform: "iOS" }],
      moduleAliases: { Payments: "Payment" },
      updatedAt: null,
    };
    const options = { kind: "buildVsPlan", title: "Daily SIT", preparedBy: "Daniel", goLive: "2026-11-01", defectNotes: {} };
    await writeItems([
      { key: "settings", value: settings },
      { key: "report-options:24", value: options },
      { key: "report-snapshots:24:157:all", value: [{ at: "2026-10-12", figures: 1 }] },
      { key: "defect-search-left-out", value: ["d1"] },
    ]);
    const read = await readItems(["settings", "report-options:24", "report-snapshots:24:157:all", "defect-search-left-out"]);
    expect(Object.fromEntries(read.map((r) => [r.key, r.value]))).toEqual({
      settings,
      "report-options:24": options,
      "report-snapshots:24:157:all": [{ at: "2026-10-12", figures: 1 }],
      "defect-search-left-out": ["d1"],
    });
    expect(await rows("select project_id, release_id, plan_release_id from settings")).toEqual([{ project_id: 24, release_id: 157, plan_release_id: 156 }]);
    expect(await rows("select module, test_set_id, platform, excel_alias from module_mappings")).toEqual([{ module: "Payments", test_set_id: 126, platform: "iOS", excel_alias: "Payment" }]);
    const [setup] = await rows<{ go_live: unknown; kind: string; prepared_by: string }>("select kind, prepared_by, go_live::text as go_live from report_setups");
    expect(setup).toEqual({ kind: "buildVsPlan", prepared_by: "Daniel", go_live: "2026-11-01" });
    expect(await rows("select project_id, release_id from report_history")).toEqual([{ project_id: 24, release_id: 157 }]);
    expect(await rows("select key from app_store")).toEqual([{ key: "defect-search-left-out" }]);
  });

  it("rolls the whole batch back when one item cannot be saved", async () => {
    const before = await rows("select * from sync_keys");
    await db.exec("alter table report_setups add constraint title_short check (length(title) < 5)");
    try {
      await expect(
        writeItems([
          { key: "settings", value: { projectId: 1, mappings: [] } },
          { key: "report-options:24", value: { title: "Much too long" } },
        ]),
      ).rejects.toThrow(/HTTP 400/);
      expect(await rows("select * from sync_keys")).toEqual(before);
      expect(await rows("select * from settings")).toEqual([]);
    } finally {
      await db.exec("alter table report_setups drop constraint title_short");
    }
  });

  it("still reads items saved by the first version of the script", async () => {
    await db.query("insert into app_store (key, value, updated_at) values ('draft:legacy01', '{\"id\":\"legacy01\"}', '2026-10-12T08:00:00Z')");
    await db.exec(schema);
    expect(await readItems(["draft:legacy01"])).toEqual([{ key: "draft:legacy01", value: { id: "legacy01" }, updatedAt: "2026-10-12T08:00:00.000Z", deleted: false }]);
  });
});
