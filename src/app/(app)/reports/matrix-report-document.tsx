"use client";

import clsx from "clsx";
import type { ReactNode } from "react";
import type { MatrixCellStatus } from "@/lib/domain/matrix";
import { MATRIX_DEVICES, MATRIX_NETWORKS, type MatrixRagStatus, type MatrixReport } from "@/lib/domain/matrix-report";
import { formatPct } from "@/lib/domain/report";

const RAG: Record<MatrixRagStatus, { label: string; dot: string; pill: string }> = {
  green: {
    label: "GREEN",
    dot: "#16a34a",
    pill: "border-emerald-300 bg-emerald-50 text-emerald-800",
  },
  amber: {
    label: "AMBER",
    dot: "#d97706",
    pill: "border-amber-300 bg-amber-50 text-amber-800",
  },
  red: {
    label: "RED",
    dot: "#dc2626",
    pill: "border-red-300 bg-red-50 text-red-800",
  },
};

const CELL_COLOR: Record<MatrixCellStatus, string> = {
  notStarted: "#94a3b8",
  inProgress: "#4f46e5",
  covered: "#16a34a",
  failed: "#dc2626",
};

const CELL_LABEL: Record<MatrixCellStatus, string> = {
  notStarted: "Not started",
  inProgress: "In progress",
  covered: "Covered",
  failed: "Failed",
};

const n = (value: number) => value.toLocaleString();
const dateText = (iso: string | null, withYear = true) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        ...(withYear ? { year: "numeric" } : {}),
      })
    : "—";
const dateTimeText = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function PageHead({ report }: { report: MatrixReport }) {
  const rag = RAG[report.status];
  const subtitle = [
    report.environment,
    `Devices ${MATRIX_DEVICES.join(", ")}`,
    `Networks ${MATRIX_NETWORKS.join(", ")}`,
    `Report date ${dateText(report.generatedAt)}`,
    report.goLive ? `Go-live ${dateText(report.goLive)}` : null,
  ].filter(Boolean);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-300 pb-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{report.title}</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-600">{subtitle.join(" · ")}</p>
      </div>
      <span className={clsx("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11.5px] font-bold tracking-wide", rag.pill)}>
        <span className="size-2 rounded-full" style={{ background: rag.dot }} />
        OVERALL STATUS: {rag.label}
      </span>
    </header>
  );
}

function PageFoot({ report, page, pages }: { report: MatrixReport; page: number; pages: number }) {
  return (
    <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-2 text-[10.5px] text-slate-500">
      <span>
        {report.preparedBy && `Prepared by ${report.preparedBy} · `}
        Source: Matrix module ({report.projectName}), {report.releaseLabel} · Cases from SpiraTest · Generated {dateTimeText(report.generatedAt)}
      </span>
      <span>
        Page {page} / {pages}
      </span>
    </footer>
  );
}

function Page({ report, page, pages, children }: { report: MatrixReport; page: number; pages: number; children: ReactNode }) {
  return (
    <section className={clsx("report-page rounded-xl border border-slate-200 bg-white p-6 text-slate-900 shadow-soft sm:p-8", page > 1 && "report-break")}>
      <PageHead report={report} />
      <div className="mt-5 flex flex-col gap-7">{children}</div>
      <PageFoot report={report} page={page} pages={pages} />
    </section>
  );
}

function Heading({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">{children}</h2>
      {note && <p className="mt-1 text-[12px] leading-relaxed text-slate-600">{note}</p>}
    </div>
  );
}

function Table({ head, children, numeric = [] }: { head: ReactNode[]; children: ReactNode; numeric?: number[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="report-table w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className={clsx(
                  "border-b border-slate-300 bg-slate-100 px-2 py-1.5 text-[10.5px] font-semibold tracking-wide text-slate-600 uppercase",
                  numeric.includes(i) ? "text-right" : "text-left",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const td = "border-b border-slate-100 px-2 py-1.5 align-top";
const num = `${td} text-right tabular-nums`;

function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide whitespace-nowrap text-white uppercase" style={{ background: color }}>
      {children}
    </span>
  );
}

function Kpi({ label, value, hint, color }: { label: string; value: ReactNode; hint?: ReactNode; color: string }) {
  return (
    <div className="rounded-lg border border-slate-200 border-t-4 bg-white px-3 py-2.5" style={{ borderTopColor: color }}>
      <p className="text-[10.5px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 text-2xl leading-tight font-bold tabular-nums" style={{ color }}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-slate-600">{hint}</p>}
    </div>
  );
}

function SummaryPage({ report }: { report: MatrixReport }) {
  const k = report.kpis;
  return (
    <>
      <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[12.5px] leading-relaxed text-slate-700">{report.summary}</p>
      <p className="text-[12.5px] leading-relaxed text-slate-700">{report.statusReason}</p>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Cells covered" value={`${k.covered}/${k.cells}`} hint={formatPct(k.coveragePct)} color="#16a34a" />
        <Kpi label="Cells started" value={n(k.started)} hint={`${k.notStarted} not started`} color="#4f46e5" />
        <Kpi label="Failed cells" value={n(k.failedCells)} color="#b91c1c" />
        <Kpi label="Runs executed" value={n(k.executedRuns)} hint={formatPct(k.execPct)} color="#0369a1" />
        <Kpi label="Passed" value={n(k.passed)} hint={`${formatPct(k.passPct)} pass rate`} color="#15803d" />
        <Kpi label="Sessions" value={n(k.sessions)} hint={`${n(k.failed)} failed · ${n(k.blocked)} blocked`} color="#334155" />
      </div>
      <div>
        <Heading note="OEM × carrier coverage for this release. Covered = planned smoke (or larger pack) fully executed with no failures.">
          1. Device × network board
        </Heading>
        <Table head={["Device", ...MATRIX_NETWORKS]}>
          {MATRIX_DEVICES.map((device) => (
            <tr key={device}>
              <td className={`${td} font-medium`}>{device}</td>
              {MATRIX_NETWORKS.map((network) => {
                const cell = report.cells.find((c) => c.device === device && c.network === network)!;
                return (
                  <td key={network} className={td}>
                    <div className="flex flex-col gap-0.5">
                      <Pill color={CELL_COLOR[cell.status]}>{CELL_LABEL[cell.status]}</Pill>
                      <span className="text-[11px] text-slate-500 tabular-nums">
                        {cell.executed}/{cell.planned || "—"}
                        {cell.failed ? ` · ${cell.failed} failed` : ""}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </Table>
      </div>
    </>
  );
}

function DetailPage({ report }: { report: MatrixReport }) {
  return (
    <>
      <div>
        <Heading note="Each cell with counts. Planned is smoke size for that device’s platform, or the larger pack if a fuller session was run.">
          2. Cell detail
        </Heading>
        <Table head={["Device", "Network", "Status", "Planned", "Executed", "Passed", "Failed", "Blocked", "Caution", "Last result"]} numeric={[3, 4, 5, 6, 7, 8]}>
          {report.cells.map((c) => (
            <tr key={`${c.device}|${c.network}`}>
              <td className={td}>{c.device}</td>
              <td className={td}>{c.network}</td>
              <td className={td}>
                <Pill color={CELL_COLOR[c.status]}>{CELL_LABEL[c.status]}</Pill>
              </td>
              <td className={num}>{n(c.planned)}</td>
              <td className={num}>{n(c.executed)}</td>
              <td className={num}>{n(c.passed)}</td>
              <td className={num}>{n(c.failed)}</td>
              <td className={num}>{n(c.blocked)}</td>
              <td className={num}>{n(c.caution)}</td>
              <td className={td}>{dateText(c.lastAt, false)}</td>
            </tr>
          ))}
        </Table>
      </div>

      <div>
        <Heading note="Failed and blocked matrix runs. Defects should cite device and network in Environment.">
          3. Failures and blocks
        </Heading>
        {report.failures.length === 0 ? (
          <p className="text-[12.5px] text-slate-600">No failed or blocked matrix runs for this release.</p>
        ) : (
          <Table head={["Device", "Network", "TC", "Case", "Module", "Status", "Comment", "Tester", "When"]}>
            {report.failures.map((f, i) => (
              <tr key={`${f.device}|${f.network}|${f.testCaseId}|${i}`}>
                <td className={td}>{f.device}</td>
                <td className={td}>{f.network}</td>
                <td className={td}>TC{f.testCaseId}</td>
                <td className={`${td} font-medium`}>{f.name}</td>
                <td className={td}>{f.module}</td>
                <td className={td}>
                  <Pill color={f.status === "failed" ? "#dc2626" : "#d97706"}>{f.status}</Pill>
                </td>
                <td className={td}>{f.comment || "—"}</td>
                <td className={td}>{f.tester || "—"}</td>
                <td className={td}>{dateText(f.at)}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      <div>
        <Heading note="Execution sessions started in the Matrix module.">4. Sessions</Heading>
        {report.sessions.length === 0 ? (
          <p className="text-[12.5px] text-slate-600">No sessions yet. Start one from Matrix after loading Spira cases.</p>
        ) : (
          <Table head={["Device", "Network", "Pack", "Module", "Tester", "Executed", "Passed", "Failed", "Updated"]} numeric={[5, 6, 7]}>
            {report.sessions.map((s) => (
              <tr key={s.id}>
                <td className={td}>{s.device}</td>
                <td className={td}>{s.network}</td>
                <td className={td}>{s.pack}</td>
                <td className={td}>{s.module || "—"}</td>
                <td className={td}>{s.tester || "—"}</td>
                <td className={num}>
                  {s.executed}/{s.total}
                </td>
                <td className={num}>{s.passed}</td>
                <td className={num}>{s.failed}</td>
                <td className={td}>{dateText(s.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </>
  );
}

/** Device × network report using the same page chrome as the Spira executive report. */
export function MatrixReportDocument({ report }: { report: MatrixReport }) {
  const pages = [<SummaryPage key="summary" report={report} />, <DetailPage key="detail" report={report} />];
  return (
    <div className="report-doc flex flex-col gap-6">
      {pages.map((content, i) => (
        <Page key={i} report={report} page={i + 1} pages={pages.length}>
          {content}
        </Page>
      ))}
    </div>
  );
}
