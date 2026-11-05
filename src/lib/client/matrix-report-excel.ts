import type { MatrixReport } from "@/lib/domain/matrix-report";
import { matrixReportFileName } from "@/lib/domain/matrix-report";
import { formatPct } from "@/lib/domain/report";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]+/g, "-").slice(0, 31) || "Sheet";
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "matrix-report";
}

type Workbook = import("exceljs").Workbook;

function addSheet(wb: Workbook, name: string, rows: Array<Record<string, unknown>>) {
  const data = rows.length ? rows : [{ Note: "No rows." }];
  const keys = Object.keys(data[0]);
  const sheet = wb.addWorksheet(safeSheetName(name), { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow(keys);
  const header = sheet.getRow(1);
  header.font = { bold: true };
  for (const row of data) sheet.addRow(keys.map((k) => row[k] ?? ""));
  sheet.columns.forEach((col) => {
    let width = 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = cell.text ?? (cell.value == null ? "" : String(cell.value));
      width = Math.max(width, Math.min(48, text.length + 2));
    });
    col.width = width;
  });
}

/** Excel pack matching the matrix executive report sheets. */
export async function exportMatrixReportWorkbook(report: MatrixReport): Promise<void> {
  const ExcelJS = await import("exceljs");
  const wb: Workbook = new ExcelJS.Workbook();
  wb.creator = "Spira Test Set Reconciler";
  wb.created = new Date(report.generatedAt);
  wb.title = report.title;

  const k = report.kpis;
  addSheet(wb, "Summary", [
    { Field: "Title", Value: report.title },
    { Field: "Project", Value: report.projectName },
    { Field: "Release", Value: report.releaseLabel },
    { Field: "Environment", Value: report.environment },
    { Field: "Prepared by", Value: report.preparedBy },
    { Field: "Status", Value: report.status.toUpperCase() },
    { Field: "Status reason", Value: report.statusReason },
    { Field: "Summary", Value: report.summary },
    { Field: "Cells covered", Value: `${k.covered}/${k.cells}` },
    { Field: "Coverage %", Value: formatPct(k.coveragePct) },
    { Field: "Runs executed", Value: k.executedRuns },
    { Field: "Exec %", Value: formatPct(k.execPct) },
    { Field: "Passed", Value: k.passed },
    { Field: "Pass %", Value: formatPct(k.passPct) },
    { Field: "Failed", Value: k.failed },
    { Field: "Generated", Value: report.generatedAt },
  ]);

  addSheet(
    wb,
    "Coverage board",
    report.cells.map((c) => ({
      Device: c.device,
      Network: c.network,
      Status: c.status,
      Planned: c.planned,
      Executed: c.executed,
      Passed: c.passed,
      Failed: c.failed,
      Blocked: c.blocked,
      Caution: c.caution,
      "Last result": day(c.lastAt),
    })),
  );

  addSheet(
    wb,
    "Failures",
    report.failures.map((f) => ({
      Device: f.device,
      Network: f.network,
      "TC ID": f.testCaseId,
      Case: f.name,
      Module: f.module,
      Status: f.status,
      Comment: f.comment,
      Tester: f.tester,
      When: day(f.at),
    })),
  );

  addSheet(
    wb,
    "Sessions",
    report.sessions.map((s) => ({
      Device: s.device,
      Network: s.network,
      Pack: s.pack,
      Module: s.module ?? "",
      Tester: s.tester,
      Executed: `${s.executed}/${s.total}`,
      Passed: s.passed,
      Failed: s.failed,
      Updated: day(s.updatedAt),
    })),
  );

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(matrixReportFileName(report))}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
