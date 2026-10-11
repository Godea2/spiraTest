import { effectiveColumn } from "@/lib/domain/board";
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
