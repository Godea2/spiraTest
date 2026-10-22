import type { Report } from "@/lib/domain/report";
import {
  formatPct,
  LEVELS,
  MODULE_STATUS_LABEL,
  OUTCOME_LABEL,
  OUTCOMES,
  RETEST_LABEL,
} from "@/lib/domain/report";
import { buildReportSummaryGrid } from "./report";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

const FILL = {
  header: "FF1E293B",
  section: "FFE2E8F0",
  zebra: "FFF8FAFC",
  green: "FFDCFCE7",
  amber: "FFFEF3C7",
  red: "FFFEE2E2",
  greenStrong: "FF16A34A",
  amberStrong: "FFD97706",
  redStrong: "FFDC2626",
  white: "FFFFFFFF",
  link: "FF4338CA",
} as const;

type Workbook = import("exceljs").Workbook;
type Worksheet = import("exceljs").Worksheet;
type Cell = import("exceljs").Cell;

function fillSolid(argb: string) {
  return { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } };
}

function thinBorder() {
  const edge = { style: "thin" as const, color: { argb: "FFCBD5E1" } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]+/g, "-").slice(0, 31) || "Sheet";
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "report";
}

function isHttp(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function statusTone(value: unknown): "green" | "amber" | "red" | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "green" || v === "met" || v === "ready" || v === "passed" || v === "yes") return "green";
  if (v === "amber" || v === "caution" || v === "in progress" || v === "at risk") return "amber";
  if (v === "red" || v === "not met" || v === "failed" || v === "blocked" || v === "no") return "red";
  if (/\bcritical\b/.test(v) || /\bhigh\b/.test(v)) return "red";
  if (/\bmedium\b/.test(v)) return "amber";
  if (/\blow\b/.test(v)) return "green";
  return null;
}

function paintStatus(cell: Cell, value: unknown): void {
  const tone = statusTone(value);
  if (!tone) return;
  const map = {
    green: { bg: FILL.green, fg: "FF14532D" },
    amber: { bg: FILL.amber, fg: "FF78350F" },
    red: { bg: FILL.red, fg: "FF7F1D1D" },
  } as const;
  cell.fill = fillSolid(map[tone].bg);
  cell.font = { ...(cell.font ?? {}), color: { argb: map[tone].fg }, bold: true };
}

function autosize(sheet: Worksheet, min = 8, max = 42): void {
  sheet.columns.forEach((col) => {
    let width = min;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = cell.text ?? (cell.value == null ? "" : String(cell.value));
      width = Math.max(width, Math.min(max, text.length + 2));
    });
    col.width = width;
  });
}

function styleHeaderRow(sheet: Worksheet, rowNumber: number, colCount: number): void {
  const row = sheet.getRow(rowNumber);
  for (let c = 1; c <= colCount; c += 1) {
    const cell = row.getCell(c);
    cell.fill = fillSolid(FILL.header);
    cell.font = { bold: true, color: { argb: FILL.white }, size: 10, name: "Calibri" };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = thinBorder();
  }
  row.height = 22;
}

function addTableSheet(wb: Workbook, name: string, rows: Array<Record<string, unknown>>): void {
  const data = rows.length ? rows : [{ Note: "Nothing to show" }];
  const keys = Object.keys(data[0]);
  const sheet = wb.addWorksheet(safeSheetName(name), {
    views: [{ state: "frozen", ySplit: 1, activeCell: "A2" }],
  });
  sheet.addRow(keys);
  styleHeaderRow(sheet, 1, keys.length);

  data.forEach((row, i) => {
    const values = keys.map((k) => row[k] ?? "");
    const excelRow = sheet.addRow(values);
    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = keys[colNumber - 1];
      const raw = row[key];
      cell.border = thinBorder();
      cell.font = { name: "Calibri", size: 10, color: { argb: "FF0F172A" } };
      cell.alignment = {
        vertical: "middle",
        wrapText: typeof raw === "string" && raw.length > 40,
        horizontal: typeof raw === "number" ? "right" : "left",
      };
      if (i % 2 === 1) cell.fill = fillSolid(FILL.zebra);
      if (key === "Status" || key === "Severity" || key === "Level" || key === "Priority") paintStatus(cell, raw);
      if (key === "Link" && isHttp(raw)) {
        cell.value = { text: "Open in Spira", hyperlink: raw };
        cell.font = { name: "Calibri", size: 10, color: { argb: FILL.link }, underline: true };
      }
    });
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: data.length + 1, column: keys.length },
  };
  autosize(sheet);
}

function addSummarySheet(wb: Workbook, report: Report): void {
  const sheet = wb.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  const rag = report.status;
  const ragFill = rag === "green" ? FILL.greenStrong : rag === "amber" ? FILL.amberStrong : FILL.redStrong;

  sheet.mergeCells("A1:B1");
  const title = sheet.getCell("A1");
  title.value = report.title;
  title.font = { name: "Calibri", size: 18, bold: true, color: { argb: "FF0F172A" } };
  title.alignment = { vertical: "middle" };
  sheet.getRow(1).height = 28;

  sheet.mergeCells("A2:B2");
  const subtitle = sheet.getCell("A2");
  subtitle.value = `${report.projectName} · ${report.environment} · ${report.scopedLabel}`;
  subtitle.font = { name: "Calibri", size: 11, color: { argb: "FF475569" } };

  sheet.getCell("A3").value = "Overall status";
  sheet.getCell("A3").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
  const status = sheet.getCell("B3");
  status.value = report.status.toUpperCase();
  status.fill = fillSolid(ragFill);
  status.font = { name: "Calibri", size: 12, bold: true, color: { argb: FILL.white } };
  status.alignment = { horizontal: "center", vertical: "middle" };
  sheet.getRow(3).height = 22;

  sheet.getCell("A4").value = "Status reason";
  sheet.getCell("A4").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
  sheet.mergeCells("B4:B4");
  sheet.getCell("B4").value = report.statusReason;
  sheet.getCell("B4").font = { name: "Calibri", size: 10, color: { argb: "FF0F172A" } };
  sheet.getCell("B4").alignment = { wrapText: true };

  let r = 6;
  for (const [label, value] of buildReportSummaryGrid(report)) {
    // Skip fields already shown in the cover header.
    if (label === "Report" || label === "Overall status" || label === "Status reason") continue;
    if (label === "" && value === "") {
      r += 1;
      continue;
    }
    const isSection = value === "" && ["Key figures", "By platform", "Narrative"].includes(String(label));
    const labelCell = sheet.getCell(r, 1);
    const valueCell = sheet.getCell(r, 2);
    labelCell.value = label;
    valueCell.value = value;
    if (isSection) {
      sheet.mergeCells(r, 1, r, 2);
      labelCell.value = label;
      labelCell.fill = fillSolid(FILL.section);
      labelCell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF0F172A" } };
      labelCell.alignment = { vertical: "middle" };
      sheet.getRow(r).height = 20;
    } else {
      labelCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF334155" } };
      valueCell.font = { name: "Calibri", size: 10, color: { argb: "FF0F172A" } };
      valueCell.alignment = { wrapText: true, vertical: "top" };
      labelCell.alignment = { vertical: "top" };
      if (label === "Pass rate" || label === "Executed %" || String(label).includes("pass rate")) {
        paintStatus(valueCell, Number.parseFloat(String(value)) >= 80 ? "green" : Number.parseFloat(String(value)) >= 60 ? "amber" : "red");
      }
    }
    r += 1;
  }

  sheet.getColumn(1).width = 36;
  sheet.getColumn(2).width = 78;
}

/** Styled workbook matching the executive report: cover Summary + section tables. */
export async function exportReportWorkbookStyled(report: Report, siteUrl: string | null): Promise<void> {
  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = "Spira Test Set Reconciler";
  wb.created = new Date(report.generatedAt);
  wb.modified = new Date();
  wb.title = report.title;

  const link = (path: string) => (siteUrl ? `${siteUrl}/${report.projectId}/${path}` : "");

  addSummarySheet(wb, report);

  addTableSheet(
    wb,
    "Modules",
    [...report.modules, ...report.laterModules].map((m) => ({
      Module: m.name,
      [report.labels.inBuild]: m.inBuild ? "Yes" : "No",
      Platforms: m.streams.join(", "),
      "Total plan": m.plan,
      [report.labels.build]: m.inScope,
      "Later builds": m.laterBuilds,
      Added: m.added,
      Executed: m.executed,
      "Exec %": formatPct(m.execPct),
      ...Object.fromEntries(OUTCOMES.map((o) => [OUTCOME_LABEL[o], m.outcomes[o]])),
      "Still to run": m.stillToRun,
      "Pass %": formatPct(m.passPct),
      "Failed cases": m.failedCases,
      "Open defects": m.openDefects,
      Status: m.inBuild ? MODULE_STATUS_LABEL[m.status] : "Later build",
      ...Object.fromEntries(report.streams.map((s) => [`${s} run`, m.byStream[s] ? `${m.byStream[s]!.executed} / ${m.byStream[s]!.total}` : ""])),
      "Last run": day(m.lastRun),
    })),
  );
  addTableSheet(
    wb,
    "Exit criteria",
    report.criteria.map((c, i) => ({
      "#": i + 1,
      Criterion: c.label,
      Target: c.target,
      Actual: c.actual,
      Status: c.met ? "Met" : "Not met",
    })),
  );
  if (report.cycle) {
    const cycle = report.cycle;
    addTableSheet(
      wb,
      "Cycle change",
      cycle.rows.map((r) => ({
        Module: r.name,
        [`${cycle.baselineName} (${cycle.stream})`]: r.before,
        [`${cycle.scopedName} (${cycle.stream})`]: r.now,
        Movement: r.movement,
      })),
    );
  }
  addTableSheet(
    wb,
    "Risks and actions",
    report.narrative.actions.map((a) => ({ Risk: a.title, Detail: a.detail, Action: a.action })),
  );
  addTableSheet(
    wb,
    "Scope",
    report.scope.rows.map((r) => ({
      Module: r.name,
      Baseline: r.baseline,
      "In scope": r.inScope,
      "In both": r.both,
      "Baseline only": r.deferred,
      Added: r.added,
      "Baseline covered": formatPct(r.coveragePct),
      ...Object.fromEntries(report.scope.streams.flatMap((s) => [[`${s} baseline`, r.baselineStreams[s] ?? 0], [`${s} in scope`, r.scopedStreams[s] ?? 0]])),
    })),
  );
  addTableSheet(
    wb,
    "Defects today",
    report.defects.today.map((d) => ({
      ID: d.incidentId != null ? `IN:${d.incidentId}` : "",
      Defect: d.title,
      Source: d.source === "spira" ? (d.alsoInApp ? "Spira + app" : "Spira") : "This app",
      Status: d.status ?? "",
      Open: d.open ? "Yes" : "No",
      Raised: day(d.createdAt),
      Link: d.incidentId != null ? link(`Incident/${d.incidentId}.aspx`) : "",
    })),
  );
  addTableSheet(
    wb,
    "Defects",
    report.defects.rows.map((d) => ({
      ID: `IN:${d.incident.incidentId}`,
      Defect: d.incident.name,
      Status: d.incident.status ?? "",
      Open: d.incident.open ? "Yes" : "No",
      Severity: d.severity,
      Priority: d.priority,
      Retest: RETEST_LABEL[d.retest],
      "Age (days)": d.ageDays ?? "",
      Feature: d.feature,
      Scope: d.phase === "in" ? report.labels.inBuild : d.phase === "out" ? report.labels.outside : d.phase === "tbc" ? "To confirm" : "",
      Rationale: d.rationale,
      Modules: d.modules.join(", "),
      "Test cases": d.testCaseIds.map((id) => `TC:${id}`).join(", "),
      "Failed runs": d.failedRuns,
      Release: d.incident.detectedRelease ?? "",
      Raised: day(d.incident.createdAt),
      Owner: d.incident.owner ?? "",
      Link: link(`Incident/${d.incident.incidentId}.aspx`),
    })),
  );
  addTableSheet(
    wb,
    "Defects by severity",
    LEVELS.map((l) => ({
      Level: l,
      "0–2 days": report.defects.severityAge[l][0],
      "3–5": report.defects.severityAge[l][1],
      "6–10": report.defects.severityAge[l][2],
      "> 10": report.defects.severityAge[l][3],
      "Open by priority": report.defects.byPriority[l],
      [`Open by priority, ${report.labels.inBuild.toLowerCase()}`]: report.defects.byPriorityInBuild[l],
    })),
  );
  addTableSheet(
    wb,
    "Failed cases",
    report.failedCases.map((c) => ({
      "Test case": `TC:${c.testCaseId}`,
      Name: c.name,
      Module: c.module,
      "Failed on": c.streams.join(", "),
      Defects: c.checked ? c.incidentIds.map((id) => `IN:${id}`).join(", ") || "None linked" : "Not checked",
      Link: link(`TestCase/${c.testCaseId}.aspx`),
    })),
  );
  addTableSheet(
    wb,
    "Data checks",
    report.findings.map((f) => ({ Severity: f.severity, Check: f.check, "Applies to": f.appliesTo, Detail: f.detail })),
  );
  const setRow = (scope: string) => (r: Report["testSets"][number]) => ({
    Scope: scope,
    "Test set": r.set.name,
    ID: `TX:${r.set.testSetId}`,
    Module: r.module,
    Platform: r.stream,
    Folder: r.folder,
    Release: r.set.releaseVersion ?? "",
    Status: r.set.status ?? "",
    Owner: r.set.owner ?? "",
    Planned: day(r.set.plannedDate),
    "Last executed": day(r.set.executionDate),
    Passed: r.set.counts.passed,
    Failed: r.set.counts.failed,
    Blocked: r.set.counts.blocked,
    Caution: r.set.counts.caution,
    "Not run": r.set.counts.notRun,
    "N/A": r.set.counts.notApplicable,
    "Spira total": r.spiraTotal,
    "Cases read": r.read ?? "",
    Overdue: r.overdue ? "Yes" : "",
    Link: link(`TestSet/${r.set.testSetId}.aspx`),
  });
  addTableSheet(wb, "Test sets", [...report.testSets.map(setRow("In scope")), ...report.baselineSets.map(setRow("Baseline"))]);
  addTableSheet(
    wb,
    "Added cases",
    report.scope.added.map((c) => ({ "Test case": `TC:${c.testCaseId}`, Name: c.name, Module: c.module })),
  );
  addTableSheet(
    wb,
    "Baseline only",
    report.scope.deferred.map((c) => ({ "Test case": `TC:${c.testCaseId}`, Name: c.name, Module: c.module })),
  );
  addTableSheet(
    wb,
    "Trend",
    report.trend.days.map((d) => ({
      Day: d.day,
      "Runs last executed": d.executed,
      "Of which failed": d.failed,
      "Executed so far": d.cumulative,
    })),
  );

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFileName(`${report.title} ${day(report.generatedAt)}`)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
