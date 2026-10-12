import "server-only";
import { summarizeDraft } from "@/lib/domain/board";
import { executionCards, executionCounts } from "@/lib/domain/execution";
import { ACTIVITY_KEY, mergeActivity } from "@/lib/domain/store-sync";
import type { Draft } from "@/lib/domain/types";

/**
 * Turns a saved item into rows for the Supabase tables (see supabase/schema.sql). The full item is always
 * kept as it was saved; the columns are what is worth querying. A field that is missing or of the wrong
 * type becomes empty instead of failing the save.
 */

export type WriteKind = "settings" | "draft" | "defects" | "activity" | "report_setup" | "report_history" | "other";

type Row = Record<string, unknown>;

export interface WritePayload {
  key: string;
  kind: WriteKind;
  deleted: boolean;
  size: number;
  value?: unknown;
  row?: Row;
  rows?: Row[];
  children?: Row[];
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 2_147_483_647 ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const time = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const day = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const record = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ints = (v: unknown): number[] => list(v).map(int).filter((n): n is number => n !== null);

const REPORT_SETUP = /^report-options:(\d+)$/;
const REPORT_HISTORY = /^report-snapshots:(\d+):([^:]+):/;

export function kindOf(key: string): WriteKind {
  if (key === "settings") return "settings";
  if (key.startsWith("draft:")) return "draft";
  if (key === "defects") return "defects";
  if (key === ACTIVITY_KEY) return "activity";
  if (REPORT_SETUP.test(key)) return "report_setup";
  if (REPORT_HISTORY.test(key)) return "report_history";
  return "other";
}

export function toPayload(key: string, value: unknown, writtenAt: string): WritePayload {
  const deleted = value === null || value === undefined;
  const base = { key, deleted, size: deleted ? 0 : JSON.stringify(value).length };
  const kind = kindOf(key);
  if (deleted) return { ...base, kind };
  const typed =
    kind === "settings" && record(value)
      ? settingsRows(value)
      : kind === "draft" && record(value)
        ? draftRows(key.slice("draft:".length), value, writtenAt)
        : kind === "defects" && Array.isArray(value)
          ? defectRows(value, writtenAt)
          : kind === "activity" && Array.isArray(value)
            ? { rows: activityRows(value) }
            : kind === "report_setup" && record(value)
              ? { value, row: reportSetupRow(key, value) }
              : kind === "report_history"
                ? { value, row: reportHistoryRow(key) }
                : null;
  return typed ? { ...base, kind, ...typed } : { ...base, kind: "other", value };
}

function settingsRows(s: Row): Partial<WritePayload> {
  const aliases = record(s.moduleAliases) ? s.moduleAliases : {};
  return {
    value: s,
    row: { project_id: int(s.projectId), release_id: int(s.releaseId), release_label: text(s.releaseLabel), plan_release_id: int(s.planReleaseId) },
    children: list(s.mappings)
      .filter(record)
      .filter((m) => text(m.module) !== null && int(m.testSetId) !== null)
      .map((m) => ({
        module: m.module,
        test_set_id: m.testSetId,
        test_set_name: text(m.testSetName),
        platform: text(m.platform),
        excel_alias: text(aliases[m.module as string]),
      })),
  };
}

function draftRows(id: string, d: Row, writtenAt: string): Partial<WritePayload> {
  const draft = d as unknown as Draft;
  let summary: ReturnType<typeof summarizeDraft> | null = null;
  try {
    summary = summarizeDraft(draft);
  } catch {
    // an older or partial draft: the counts stay empty
  }
  let execution: { executed: number; total: number } | null = null;
  try {
    if (draft.execution) {
      const counts = executionCounts(executionCards(draft), draft.execution);
      execution = { executed: counts.total - counts.notRun, total: counts.total };
    }
  } catch {
    // as above
  }
  const projectId = int(d.projectId) ?? 0;
  const moduleName = text(d.module) ?? "";
  const run = (r: Row, recordedBy: "execution" | "sign-off") => ({
    draft_id: id,
    test_run_id: int(r.testRunId),
    project_id: projectId,
    module: moduleName,
    test_set_id: int(r.testSetId),
    test_case_id: int(r.testCaseId),
    test_set_test_case_id: int(r.testSetTestCaseId),
    status: text(r.status),
    tester: recordedBy === "execution" ? text(r.tester) : null,
    comment: recordedBy === "execution" ? text(r.comment) : null,
    executed_at: time(r.at),
    recorded_by: recordedBy,
  });
  const execRuns = record(d.execution) ? list(d.execution.runs) : [];
  const signOffRuns = record(d.apply) ? list(d.apply.signOffRuns) : [];
  const runs = [...execRuns.filter(record).map((r) => run(r, "execution")), ...signOffRuns.filter(record).map((r) => run(r, "sign-off"))].filter(
    (r) => r.test_run_id !== null && r.test_set_id !== null && r.test_case_id !== null && r.test_set_test_case_id !== null && r.status !== null && r.executed_at !== null,
  );
  return {
    value: d,
    row: {
      id,
      project_id: projectId,
      module: moduleName,
      name: text(d.name) ?? "",
      status: text(d.status) ?? "draft",
      stage: summary?.completedAt ? "completed" : "review",
      release_id: int(d.releaseId),
      release_label: text(d.releaseLabel),
      workbook: record(d.source) ? text(d.source.fileName) : null,
      test_set_ids: ints(d.testSetIds),
      platforms: summary?.platforms ?? [],
      total_cases: summary?.counts.total ?? null,
      in_scope: summary?.counts.inScope ?? null,
      defects: summary?.counts.defects ?? null,
      blocked: summary?.counts.blocked ?? null,
      out_of_scope: summary?.counts.outOfScope ?? null,
      needs_review: summary?.counts.needsReview ?? null,
      missing_from_spira: summary?.missingFromSpira ?? null,
      executed: execution?.executed ?? null,
      execution_total: execution?.total ?? null,
      completed_at: time(summary?.completedAt),
      created_at: time(d.createdAt) ?? writtenAt,
      updated_at: time(d.updatedAt) ?? writtenAt,
    },
    children: runs,
  };
}

function defectRows(entries: unknown[], writtenAt: string): Partial<WritePayload> {
  const byId = new Map<string, Row>();
  for (const e of entries) if (record(e) && typeof e.id === "string" && e.id) byId.set(e.id, e);
  const defects = [...byId.values()];
  return {
    rows: defects.map((d) => ({
      id: d.id,
      project_id: int(d.projectId) ?? 0,
      incident_id: int(d.incidentId),
      title: text(d.title) ?? "",
      description: text(d.description),
      tester: text(d.tester),
      logged_at: time(d.at) ?? writtenAt,
      linked_steps: int(d.linkedSteps) ?? 0,
      case_count: list(d.cases).length,
      created_test_case_id: record(d.created) ? int(d.created.testCaseId) : null,
      data: d,
    })),
    children: defects.flatMap((d) =>
      list(d.cases)
        .filter(record)
        .map((c) => ({
          defect_id: d.id,
          draft_id: text(c.draftId),
          module: text(c.module),
          test_set_id: int(c.testSetId),
          test_case_id: int(c.testCaseId),
          test_set_test_case_id: int(c.testSetTestCaseId),
          test_run_id: int(c.testRunId),
          name: text(c.name),
          step_label: text(c.stepLabel),
          moved_from: text(c.from),
        })),
    ),
  };
}

function activityRows(entries: unknown[]): Row[] {
  return mergeActivity(null, entries)
    .filter((e) => time(e.at) !== null)
    .map((e) => ({
      id: e.id,
      at: time(e.at),
      type: text(e.type) ?? "",
      message: text(e.message) ?? "",
      draft_id: text(e.draftId),
      module: text(e.module),
      details: record(e.details) ? e.details : null,
      data: e,
    }));
}

function reportSetupRow(key: string, o: Row): Row {
  return {
    project_id: Number(REPORT_SETUP.exec(key)![1]),
    kind: text(o.kind),
    title: text(o.title),
    prepared_by: text(o.preparedBy),
    go_live: day(o.goLive),
  };
}

function reportHistoryRow(key: string): Row {
  const [, project, release] = REPORT_HISTORY.exec(key)!;
  return { project_id: Number(project), release_id: /^\d+$/.test(release) ? Number(release) : null };
}
