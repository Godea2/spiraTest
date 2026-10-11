import { effectiveColumn } from "@/lib/domain/board";
import { currentStatus, executionCards, executionCounts, STATUS_LABEL } from "@/lib/domain/execution";
import { keywordHits } from "@/lib/domain/keywords";
import { COLUMN_LABELS, COLUMNS, type ActivityEntry, type Column, type Draft } from "@/lib/domain/types";

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "export";
}

export async function exportBoard(draft: Draft): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const setName = new Map(draft.testSets.map((s) => [s.testSetId, s.testSetName]));
  const cardByKey = new Map(draft.testSets.flatMap((s) => s.cards).map((c) => [c.key, c]));
  const hits = keywordHits([...cardByKey.values()], draft.testSetKeywords);
  const verdict = (key: string) => {
    const a = hits.has(key) ? draft.blockedReview?.[key] : undefined;
    if (!a) return { verdict: "", reason: "" };
    const who = a.source === "ai" ? `AI${a.confidence ? `, ${a.confidence} confidence` : ""}` : "keyword";
    return { verdict: `${a.blocked ? "Blocked" : "Not blocked"} (${who})`, reason: a.reason };
  };

  const sheetFor = (column: Column) =>
    draft.testSets.flatMap((set) =>
      set.cards
        .filter((card) => effectiveColumn(card, draft.decisions) === column)
        .map((card) => ({
          "Test set": set.testSetName,
          "Test set ID": set.testSetId,
          "Test case ID": card.testCaseId,
          "Test set membership ID": card.testSetTestCaseId,
          "TC ID": card.tcId ?? "",
          Name: card.name,
          "Execution status": card.executionStatus,
          Suggestion: COLUMN_LABELS[card.suggestion],
          "Manually moved": draft.decisions[card.key] ? "Yes" : "No",
          "Not-implemented keywords": hits.get(card.key)?.join(", ") ?? "",
          "Not-implemented verdict": verdict(card.key).verdict,
          "Verdict reason": verdict(card.key).reason,
          Reason: card.reason,
        })),
    );

  for (const column of COLUMNS) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetFor(column)), COLUMN_LABELS[column]);
  }
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      draft.testSets.flatMap((set) =>
        set.missingFromSpira.map((row) => ({
          "Test set": set.testSetName,
          "Test set ID": set.testSetId,
          "TC ID": row.tcId,
          "Test scenario": row.testScenario,
          Reason: row.reason,
        })),
      ),
    ),
    "Missing from Spira",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      draft.history.flatMap((entry) =>
        entry.changes.length === 0
          ? [{ When: entry.at, Action: entry.label, "Test set": "", "Test case ID": "", "Membership ID": "", From: "", To: "" }]
          : entry.changes.map((change) => {
              const card = cardByKey.get(change.key);
              return {
                When: entry.at,
                Action: entry.label,
                "Test set": card ? setName.get(card.testSetId) ?? "" : "",
                "Test case ID": card?.testCaseId ?? "",
                "Membership ID": card?.testSetTestCaseId ?? "",
                From: COLUMN_LABELS[change.from],
                To: COLUMN_LABELS[change.to],
              };
            }),
      ),
    ),
    "Change history",
  );
  XLSX.writeFile(wb, `${safeFileName(draft.name)}.xlsx`);
}

/** Execution report: a summary per test set, every In Scope case with its latest result, and every run recorded here. */
export async function exportExecution(draft: Draft, siteUrl: string | null): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const cards = executionCards(draft);
  const runs = draft.execution?.runs ?? [];
  const setName = (testSetId: number) => draft.testSets.find((s) => s.testSetId === testSetId)?.testSetName ?? `Test set ${testSetId}`;
  const runLink = (testRunId: number) => (siteUrl ? `${siteUrl}/${draft.projectId}/TestRun/${testRunId}.aspx` : "");
  const label = (status: ReturnType<typeof currentStatus>) => (status ? STATUS_LABEL[status] : "Not Run");
  const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "");

  const summaryRow = (name: string, group: typeof cards) => {
    const c = executionCounts(group, draft.execution);
    const executed = c.total - c.notRun;
    return {
      "Test set": name,
      "In Scope": c.total,
      Executed: executed,
      "Executed %": percent(executed, c.total),
      Passed: c.passed,
      Failed: c.failed,
      Blocked: c.blocked,
      Caution: c.caution,
      "Not Run": c.notRun,
      "Pass rate (of executed)": percent(c.passed, executed),
    };
  };
  const summary = [
    ...draft.testSets.map((s) => summaryRow(s.testSetName, cards.filter((c) => c.testSetId === s.testSetId))),
    ...(draft.testSets.length > 1 ? [summaryRow("All test sets", cards)] : []),
  ];
  const about = [
    ["Module", draft.module],
    ["Draft", draft.name],
    ["Release", draft.releaseLabel || draft.releaseId || ""],
    ["Statuses read from Spira", draft.execution?.checkedAt ?? "Not checked; statuses are from the comparison"],
    ["Report generated", new Date().toISOString()],
    ["Testers", [...new Set(runs.map((r) => r.tester).filter(Boolean))].join(", ")],
    [],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(about);
  XLSX.utils.sheet_add_json(summarySheet, summary, { origin: -1 });
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      cards.map((card) => {
        const last = [...runs].reverse().find((r) => r.testSetId === card.testSetId && r.testSetTestCaseId === card.testSetTestCaseId);
        return {
          "Test set": setName(card.testSetId),
          "Test case ID": card.testCaseId,
          "TC ID": card.tcId ?? "",
          Name: card.name,
          "Status in Spira": label(currentStatus(card, draft.execution)),
          "Last result recorded here": last ? STATUS_LABEL[last.status] : "",
          "Recorded at": last?.at ?? "",
          Tester: last?.tester ?? "",
          Comment: last?.comment ?? "",
          "Test run ID": last?.testRunId ?? "",
          "Test run link": last ? runLink(last.testRunId) : "",
        };
      }),
    ),
    "Cases",
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      runs.map((r) => ({
        "Recorded at": r.at,
        "Test set": setName(r.testSetId),
        "Test case ID": r.testCaseId,
        Result: STATUS_LABEL[r.status],
        Tester: r.tester,
        Comment: r.comment,
        "Test run ID": r.testRunId,
        "Test run link": runLink(r.testRunId),
      })),
    ),
    "Runs recorded here",
  );
  XLSX.writeFile(wb, `${safeFileName(`${draft.name} - execution report`)}.xlsx`);
}

export async function exportActivity(entries: ActivityEntry[]): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      entries.map((e) => ({
        When: e.at,
        Type: e.type,
        Message: e.message,
        Module: e.module ?? "",
        "Draft ID": e.draftId ?? "",
        Details: e.details ? JSON.stringify(e.details) : "",
      })),
    ),
    "Activity",
  );
  XLSX.writeFile(wb, `activity-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
