import clsx from "clsx";
import type { ReactNode } from "react";
import {
  AGE_BUCKETS,
  formatPct,
  LEVELS,
  MODULE_STATUS_LABEL,
  pct,
  RETEST_LABEL,
  type ChangeRow,
  type ModuleRow,
  type ModuleStatus,
  type RagStatus,
  type Report,
  type RetestState,
} from "@/lib/domain/report";
import { Donut, OUTCOME_COLOR, OutcomeBar, OutcomeLegend, TargetBar, TrendChart } from "./charts";

const RAG: Record<RagStatus, { label: string; color: string }> = {
  green: { label: "GREEN", color: "#16a34a" },
  amber: { label: "AMBER", color: "#d97706" },
  red: { label: "RED", color: "#dc2626" },
};

const MODULE_STATUS_COLOR: Record<ModuleStatus, string> = {
  ready: "#16a34a",
  atRisk: "#d97706",
  inProgress: "#4f46e5",
  notStarted: "#94a3b8",
};

const n = (value: number) => value.toLocaleString();
const dateText = (iso: string | null, withYear = true) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }) : "—";
const dateTimeText = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const goLiveText = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export interface ReportChanges {
  since: string;
  rows: ChangeRow[];
}

function PageHead({ report }: { report: Report }) {
  const rag = RAG[report.status];
  const subtitle = [
    `${report.environment || report.scopedLabel}${report.streams.length ? ` (${report.streams.join(", ")})` : ""}`,
    `Report date ${dateText(report.generatedAt)}`,
    report.window.first && report.window.last ? `Runs ${dateText(report.window.first, false)} – ${dateText(report.window.last)}` : null,
    report.goLive
      ? `Go-live ${goLiveText(report.goLive)}${report.daysToGoLive !== null ? ` (${report.daysToGoLive >= 0 ? `${report.daysToGoLive} days` : `${-report.daysToGoLive} days ago`})` : ""}`
      : null,
  ].filter(Boolean);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-slate-900 pb-3">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-slate-900">{report.title}</h1>
        <p className="mt-0.5 text-[12.5px] text-slate-600">{subtitle.join(" · ")}</p>
      </div>
      <span className="rounded-md px-3 py-1.5 text-xs font-bold tracking-wide text-white" style={{ background: rag.color }}>
        OVERALL STATUS: {rag.label}
      </span>
    </header>
  );
}

function PageFoot({ report, page, pages }: { report: Report; page: number; pages: number }) {
  return (
    <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-2 text-[10.5px] text-slate-500">
      <span>
        {report.preparedBy && `Prepared by ${report.preparedBy} · `}Source: SpiraTest ({report.projectName}, project {report.projectId}), {report.scopedLabel}
        {report.hasBaseline && ` compared with ${report.baselineLabel}`} · Read live from Spira {dateTimeText(report.generatedAt)}
      </span>
      <span>
        Page {page} of {pages}
      </span>
    </footer>
  );
}

function Page({ report, page, pages, children }: { report: Report; page: number; pages: number; children: ReactNode }) {
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

function Table({ head, children, numeric = [], foot }: { head: ReactNode[]; children: ReactNode; numeric?: number[]; foot?: ReactNode }) {
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
        {foot && <tfoot>{foot}</tfoot>}
      </table>
    </div>
  );
}

const td = "border-b border-slate-100 px-2 py-1.5 align-top";
const num = `${td} text-right tabular-nums`;
const totalCell = "border-t-2 border-slate-300 bg-slate-50 px-2 py-1.5 font-semibold";

function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide whitespace-nowrap text-white uppercase" style={{ background: color }}>
      {children}
    </span>
  );
}

function Tick({ value }: { value: boolean | null }) {
  if (value === null) return <span className="text-slate-400">—</span>;
  return value ? <span className="font-bold text-emerald-600">✓</span> : <span className="font-bold text-red-600">✗</span>;
}

function Kpi({ label, value, hint, color }: { label: string; value: ReactNode; hint?: ReactNode; color?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5">
      <p className="text-[10.5px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 text-2xl leading-tight font-bold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{hint}</p>}
    </div>
  );
}

function Panel({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-200 p-3">
      <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      <div className="mt-2 flex-1">{children}</div>
      {foot && <p className="mt-2 text-[11px] text-slate-500">{foot}</p>}
    </div>
  );
}

function SpiraLink({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline-offset-2 hover:underline">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function SummaryPage({ report }: { report: Report }) {
  const k = report.kpis;
  const hasBaseline = report.hasBaseline;
  const baselineOfScoped = report.modules.reduce((t, m) => t + m.baseline, 0);
  return (
    <>
      <div className={clsx("grid gap-2.5", hasBaseline ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6")}>
        {hasBaseline && <Kpi label="Baseline" value={n(k.baseline)} hint={`cases in ${report.baselineLabel}`} />}
        <Kpi label="In scope" value={n(k.inScope)} hint={`cases in ${report.scopedLabel}`} />
        <Kpi label="Executed" value={n(k.executed)} hint={`${formatPct(k.execPct)} of ${n(k.executable)} in scope`} color="#4f46e5" />
        <Kpi label="Passed" value={n(k.outcomes.passed)} hint={`${formatPct(k.passPct)} of executed`} color={OUTCOME_COLOR.passed} />
        <Kpi label="Failed" value={n(k.outcomes.failed)} hint={`${formatPct(pct(k.outcomes.failed, k.executed))} of executed`} color={OUTCOME_COLOR.failed} />
        <Kpi label="Blocked" value={n(k.outcomes.blocked)} hint={`+ ${n(k.outcomes.caution)} passed with caution`} color={OUTCOME_COLOR.blocked} />
        <Kpi label="Not run" value={n(k.outcomes.notRun)} hint={`${formatPct(pct(k.outcomes.notRun, k.executable))} of in scope`} />
      </div>

      <div className="rounded-lg border-l-4 border-slate-900 bg-slate-50 px-4 py-3">
        <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Executive summary</p>
        <p className="mt-1 text-[13.5px] leading-relaxed text-slate-800">{report.narrative.headline}</p>
        <p className="mt-1.5 text-[12px] text-slate-600">{report.statusReason}</p>
        {report.notes && <p className="mt-2 text-[12.5px] whitespace-pre-line text-slate-800">{report.notes}</p>}
      </div>

      <div>
        <Heading
          note={
            <>
              By module. In scope = cases in {report.scopedLabel}
              {k.added > 0 && hasBaseline && `, including ${n(k.added)} not in the baseline`}
              {hasBaseline && `; baseline = cases in ${report.baselineLabel}`}. A case planned on several platforms counts once, and counts as executed once it has a
              result on each of them.
            </>
          }
        >
          1. Test cases: {hasBaseline ? "baseline vs in scope, " : ""}executed, passed, failed, blocked
        </Heading>
        <Table
          head={["Module", ...(hasBaseline ? ["Baseline"] : []), "In scope", "Executed", "Exec %", "Passed", "Failed", "Blocked", "Caution", "Not run", "Pass %"]}
          numeric={Array.from({ length: hasBaseline ? 10 : 9 }, (_, i) => i + 1)}
          foot={
            <tr>
              <td className={totalCell}>Total (Spira roll-up)</td>
              {hasBaseline && <td className={`${totalCell} text-right tabular-nums`}>{n(baselineOfScoped)}</td>}
              {[k.inScope, k.executed].map((v, i) => (
                <td key={i} className={`${totalCell} text-right tabular-nums`}>
                  {n(v)}
                </td>
              ))}
              <td className={`${totalCell} text-right tabular-nums`}>{formatPct(k.execPct)}</td>
              {[k.outcomes.passed, k.outcomes.failed, k.outcomes.blocked, k.outcomes.caution, k.outcomes.notRun].map((v, i) => (
                <td key={i} className={`${totalCell} text-right tabular-nums`}>
                  {n(v)}
                </td>
              ))}
              <td className={`${totalCell} text-right tabular-nums`}>{formatPct(k.passPct)}</td>
            </tr>
          }
        >
          {report.modules.map((m) => (
            <tr key={m.id}>
              <td className={`${td} font-medium`}>{m.name}</td>
              {hasBaseline && <td className={num}>{n(m.baseline)}</td>}
              <td className={num}>{n(m.inScope)}</td>
              <td className={num}>{n(m.executed)}</td>
              <td className={num}>{formatPct(m.execPct)}</td>
              <td className={num}>{n(m.outcomes.passed)}</td>
              <td className={clsx(num, m.outcomes.failed > 0 && "font-semibold text-red-600")}>{n(m.outcomes.failed)}</td>
              <td className={clsx(num, m.outcomes.blocked > 0 && "font-semibold text-orange-600")}>{n(m.outcomes.blocked)}</td>
              <td className={num}>{n(m.outcomes.caution)}</td>
              <td className={num}>{n(m.outcomes.notRun)}</td>
              <td className={num}>{formatPct(m.passPct)}</td>
            </tr>
          ))}
        </Table>
      </div>

      <div className="report-keep grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Panel title="Execution status" foot={`Target at exit: ${report.targets.executedPct}%`}>
          <div className="flex items-center gap-3">
            <Donut
              segments={(["passed", "failed", "blocked", "caution", "notRun"] as const).map((o) => ({ value: k.outcomes[o], color: OUTCOME_COLOR[o] }))}
              center={
                <span>
                  <span className="block text-lg font-bold tabular-nums">{formatPct(k.execPct)}</span>
                  <span className="text-[10px] text-slate-500">executed</span>
                </span>
              }
            />
            <div className="flex flex-col gap-2 text-[11px] text-slate-600">
              <OutcomeLegend show={["passed", "failed", "blocked", "caution", "notRun"]} counts={k.outcomes} />
              <span>
                {n(k.executed)} of {n(k.executable)} in-scope tests run
              </span>
            </div>
          </div>
        </Panel>
        <Panel title="Outcome of executed tests" foot={`Target at exit: ≥ ${report.targets.passRatePct}% pass`}>
          <div className="flex items-center gap-3">
            <Donut
              segments={(["passed", "failed", "blocked", "caution"] as const).map((o) => ({ value: k.outcomes[o], color: OUTCOME_COLOR[o] }))}
              center={
                <span>
                  <span className="block text-lg font-bold tabular-nums">{formatPct(k.passPct, 0)}</span>
                  <span className="text-[10px] text-slate-500">pass rate</span>
                </span>
              }
            />
            <div className="flex flex-col gap-2 text-[11px] text-slate-600">
              <OutcomeLegend show={["passed", "failed", "blocked", "caution"]} counts={k.outcomes} />
              <span>
                {n(k.outcomes.passed)} passed of {n(k.executed)} executed
              </span>
            </div>
          </div>
        </Panel>
        <Panel title="Modules ready for UAT" foot="Target: every module in scope">
          <div className="flex items-center gap-3">
            <Donut
              segments={(Object.keys(MODULE_STATUS_COLOR) as ModuleStatus[]).map((s) => ({ value: report.readiness[s], color: MODULE_STATUS_COLOR[s] }))}
              center={
                <span>
                  <span className="block text-lg font-bold tabular-nums">
                    {report.readiness.ready} / {report.modules.length}
                  </span>
                  <span className="text-[10px] text-slate-500">ready</span>
                </span>
              }
            />
            <div className="flex flex-col gap-1 text-[11px] text-slate-600">
              {(Object.keys(MODULE_STATUS_COLOR) as ModuleStatus[]).map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[2px]" style={{ background: MODULE_STATUS_COLOR[s] }} />
                  {MODULE_STATUS_LABEL[s]} <span className="font-semibold text-slate-800">{report.readiness[s]}</span>
                </span>
              ))}
            </div>
          </div>
        </Panel>
        <Panel title="Progress by test stream">
          <div className="flex flex-col gap-2.5">
            {report.streamRows.map((s) => (
              <div key={s.stream}>
                <div className="flex justify-between text-[11.5px]">
                  <span className="font-medium">{s.stream}</span>
                  <span className="text-slate-600 tabular-nums">
                    {formatPct(s.execPct, 0)} run · {n(s.executed)} / {n(s.total)}
                  </span>
                </div>
                <div className="mt-1">
                  <OutcomeBar counts={s.outcomes} height={10} show={["passed", "failed", "blocked", "caution", "notRun"]} />
                </div>
              </div>
            ))}
            {report.streamRows.length === 0 && <p className="text-[12px] text-slate-500">No cases in scope.</p>}
          </div>
        </Panel>
      </div>
    </>
  );
}

function ReadinessPage({ report }: { report: Report }) {
  const met = report.criteria.filter((c) => c.met).length;
  return (
    <>
      <div>
        <Heading
          note={`Bars show actual progress; the dark marker is the exit target. ${met} of ${report.criteria.length} criteria are met${
            met < report.criteria.length ? `; ${report.criteria.filter((c) => !c.met).map((c) => c.label.toLowerCase()).join(", ")} are not yet met` : ""
          }.`}
        >
          2. Readiness against exit criteria
        </Heading>
        <div className="report-keep mb-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
          {report.criteria
            .filter((c) => c.progress !== null)
            .map((c) => (
              <div key={c.label}>
                <div className="flex justify-between gap-2 text-[11.5px]">
                  <span className="font-medium">{c.label}</span>
                  <span className="text-slate-600 tabular-nums">
                    {c.actual} vs {c.target}
                  </span>
                </div>
                <div className="mt-1">
                  <TargetBar progress={c.progress ?? 0} mark={c.mark} met={c.met} />
                </div>
              </div>
            ))}
        </div>
        <Table head={["#", "Exit criterion", "Target", `Actual (${dateText(report.generatedAt, false)})`, "Status"]}>
          {report.criteria.map((c, i) => (
            <tr key={c.label}>
              <td className={`${td} text-slate-500`}>{i + 1}</td>
              <td className={`${td} font-medium`}>{c.label}</td>
              <td className={td}>{c.target}</td>
              <td className={td}>{c.actual}</td>
              <td className={td}>
                <Pill color={c.met ? "#16a34a" : "#dc2626"}>{c.met ? "Met" : "Not met"}</Pill>
              </td>
            </tr>
          ))}
        </Table>
      </div>

      <div>
        <Heading note="Share of each module's in-scope tests by result, across its platforms. Sorted by how much has been run.">3a. Test outcome by module</Heading>
        <div className="mb-2">
          <OutcomeLegend show={["passed", "failed", "blocked", "caution", "notRun"]} />
        </div>
        <div className="flex flex-col gap-2">
          {report.modules.map((m) => (
            <div key={m.id} className="report-keep grid grid-cols-[minmax(7rem,11rem)_1fr_minmax(9rem,12rem)] items-center gap-3 text-[12px]">
              <span className="truncate font-medium">{m.name}</span>
              <OutcomeBar counts={m.outcomes} height={14} show={["passed", "failed", "blocked", "caution", "notRun"]} />
              <span className="text-slate-600 tabular-nums">
                {n(m.executed)}/{n(m.executable)} run{m.executed > 0 && ` · ${formatPct(m.passPct)} pass`}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function whyText(report: Report): string[] {
  const by = (s: ModuleStatus) => report.modules.filter((m) => m.status === s);
  const lines: string[] = [];
  const ready = by("ready");
  if (ready.length) {
    lines.push(`${ready.map((m) => m.name).join(", ")}: every in-scope case run and passed (${n(ready.reduce((t, m) => t + m.executed, 0))}), with no open defects.`);
  }
  for (const m of by("atRisk")) {
    const toRun = m.executable - m.executed;
    lines.push(
      `${m.name}: ${n(m.outcomes.passed)} of ${n(m.executed)} passed (${formatPct(m.passPct)}), ${n(m.outcomes.failed)} failed${m.outcomes.blocked ? `, ${n(m.outcomes.blocked)} blocked` : ""}, ${m.openDefects} open defect${m.openDefects === 1 ? "" : "s"}${toRun ? ` and ${n(toRun)} still to run` : ""}.`,
    );
  }
  for (const m of by("inProgress")) lines.push(`${m.name}: ${n(m.executed)} of ${n(m.executable)} run with no failures so far.`);
  const notStarted = by("notStarted");
  if (notStarted.length) lines.push(`${notStarted.map((m) => m.name).join(", ")}: ${n(notStarted.reduce((t, m) => t + m.inScope, 0))} cases not yet started.`);
  return lines;
}

function ModulesPage({ report, changes }: { report: Report; changes: ReportChanges | null }) {
  const target = report.targets.passRatePct;
  return (
    <>
      <div>
        <Heading note="A module is ready for UAT only when every criterion is met: every case run on every platform, the pass rate at target, nothing blocked and no open defects.">
          3b. Module readiness for UAT
        </Heading>
        <Table
          head={["Module", "Platforms", "In scope", "Executed", "Exec %", "Passed", "Failed", "Blocked", "Pass %", "100% run", `Pass ≥ ${target}%`, "0 blocked", "Defects", "UAT status"]}
          numeric={[2, 3, 4, 5, 6, 7, 8]}
        >
          {report.modules.map((m: ModuleRow) => (
            <tr key={m.id}>
              <td className={`${td} font-medium`}>{m.name}</td>
              <td className={td}>{m.streams.join(" · ")}</td>
              <td className={num}>{n(m.inScope)}</td>
              <td className={num}>{n(m.executed)}</td>
              <td className={num}>{formatPct(m.execPct)}</td>
              <td className={num}>{n(m.outcomes.passed)}</td>
              <td className={num}>{n(m.outcomes.failed)}</td>
              <td className={num}>{n(m.outcomes.blocked)}</td>
              <td className={num}>{formatPct(m.passPct)}</td>
              <td className={`${td} text-center`}>
                <Tick value={m.checks.fullyRun} />
              </td>
              <td className={`${td} text-center`}>
                <Tick value={m.checks.passOk} />
              </td>
              <td className={`${td} text-center`}>
                <Tick value={m.executed ? m.checks.noBlocked : null} />
              </td>
              <td className={td}>{m.defects ? `${m.openDefects} open${m.defects > m.openDefects ? ` · ${m.defects - m.openDefects} closed` : ""}` : "—"}</td>
              <td className={td}>
                <Pill color={MODULE_STATUS_COLOR[m.status]}>{MODULE_STATUS_LABEL[m.status]}</Pill>
              </td>
            </tr>
          ))}
        </Table>
        <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-700">
          <span className="font-semibold">Why each module has this status. </span>
          {whyText(report).join(" ")}
        </div>
      </div>

      <div>
        <Heading
          note={
            changes
              ? `Compared with the report read on ${dateTimeText(changes.since)} for the same scope, kept in this browser.`
              : "This is the first report for this scope in this browser; from tomorrow, each report shows what moved since the previous one."
          }
        >
          3c. Change since the last report
        </Heading>
        {changes && (
          <Table head={["Module", `${dateText(changes.since, false)} report`, `${dateText(report.generatedAt, false)}`, "Movement"]}>
            {changes.rows.map((r) => (
              <tr key={r.name}>
                <td className={`${td} font-medium`}>{r.name}</td>
                <td className={td}>{r.before}</td>
                <td className={td}>{r.now}</td>
                <td className={clsx(td, "font-semibold", r.tone === "good" ? "text-emerald-700" : r.tone === "bad" ? "text-red-600" : "text-slate-600")}>{r.movement}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      <div className="report-keep">
        <Heading
          note={`Cases by the day of their latest run (green passed or other result, red failed); the line is the running total executed${
            report.trend.earlier ? `, including ${n(report.trend.earlier)} run before this window` : ""
          }.${report.trend.pacePerDay ? ` Recent pace: about ${Math.round(report.trend.pacePerDay)} cases per active day` : ""}${
            report.trend.daysToFinish ? `; the ${n(report.kpis.executable - report.kpis.executed)} remaining need about ${report.trend.daysToFinish} more day${report.trend.daysToFinish === 1 ? "" : "s"}.` : "."
          }`}
        >
          Execution trend, last 21 days
        </Heading>
        <TrendChart days={report.trend.days} total={report.kpis.executable} />
      </div>
    </>
  );
}

function ScopePage({ report }: { report: Report }) {
  const k = report.kpis;
  const streams = report.scope.streams;
  return (
    <>
      <div>
        <Heading
          note={`The baseline (${report.baselineLabel}) holds every test case across modules and platforms; ${report.scopedLabel} is the scope being executed. Matched by test case, module by module.`}
        >
          4. Scope: baseline vs in scope
        </Heading>
        <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <Kpi label="Baseline" value={n(k.baseline)} hint={report.baselineLabel} />
          <Kpi label="In scope" value={n(k.inScope)} hint={report.scopedLabel} />
          <Kpi label="Baseline covered" value={formatPct(k.coveragePct)} hint={`${n(k.baseline - k.deferred)} of ${n(k.baseline)} baseline cases`} color="#4f46e5" />
          <Kpi label="Baseline only" value={n(k.deferred)} hint="not in this scope" />
          <Kpi label="Added" value={n(k.added)} hint="in scope, not in the baseline" />
        </div>
        <Table
          head={["Module", "Baseline", "In scope", "In both", "Baseline only", "Added", "Covered", ...streams.map((s) => `${s} (base / scope)`)]}
          numeric={Array.from({ length: 6 + streams.length }, (_, i) => i + 1)}
        >
          {report.scope.rows.map((r) => (
            <tr key={r.id}>
              <td className={`${td} font-medium`}>{r.name}</td>
              <td className={num}>{n(r.baseline)}</td>
              <td className={num}>{n(r.inScope)}</td>
              <td className={num}>{n(r.both)}</td>
              <td className={num}>{n(r.deferred)}</td>
              <td className={clsx(num, r.added > 0 && "font-semibold text-indigo-700")}>{n(r.added)}</td>
              <td className={num}>{formatPct(r.coveragePct, 0)}</td>
              {streams.map((s) => (
                <td key={s} className={clsx(num, (r.baselineStreams[s] ?? 0) > 0 && !r.scopedStreams[s] && "text-amber-700")}>
                  {r.baselineStreams[s] ?? 0} / {r.scopedStreams[s] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-[11.5px] text-slate-500">
          Platform columns count cases per platform; amber marks a platform covered in the baseline but missing from the scope.
        </p>
      </div>
      {report.scope.added.length > 0 && report.hasBaseline && (
        <div>
          <Heading note="Usually cases written during testing, for example for a defect. Add them to the baseline if they should stay.">Cases in scope but not in the baseline</Heading>
          <p className="text-[12px] leading-relaxed text-slate-700">
            {report.scope.added
              .slice(0, 40)
              .map((c) => `TC:${c.testCaseId} ${c.name} (${c.module})`)
              .join(" · ")}
            {report.scope.added.length > 40 && ` · and ${report.scope.added.length - 40} more in the Excel export`}
          </p>
        </div>
      )}
    </>
  );
}

function DefectsPage({ report, siteUrl }: { report: Report; siteUrl: string | null }) {
  const d = report.defects;
  const ids = d.rows.map((r) => r.incident.incidentId).sort((a, b) => a - b);
  const levels = LEVELS.filter((l) => l !== "Not set" || d.severityAge[l].some(Boolean) || d.byPriority[l]);
  const incidentUrl = (id: number) => (siteUrl ? `${siteUrl}/${report.projectId}/Incident/${id}.aspx` : null);
  const retestRows: RetestState[] = ["retest", "closed", "reopened", "awaiting"];
  const shown = d.rows.slice(0, 80);
  return (
    <>
      <div>
        <Heading>5. Defects and retesting</Heading>
        <p className="text-[12.5px] leading-relaxed text-slate-700">
          {d.rows.length === 0
            ? `No defects are raised against ${report.scopedLabel} or linked to its cases.`
            : `${d.rows.length} defect${d.rows.length === 1 ? "" : "s"} in scope (IN:${ids[0]}${ids.length > 1 ? ` – IN:${ids[ids.length - 1]}` : ""}): ${d.open} open, ${d.closed} closed. ${
                d.openCriticalHigh ? `${d.openCriticalHigh} open ${d.openCriticalHigh === 1 ? "is" : "are"} Critical or High severity.` : "None open is Critical or High severity."
              } ${d.byPriority.Critical + d.byPriority.High ? `${d.byPriority.Critical + d.byPriority.High} open ${d.byPriority.Critical + d.byPriority.High === 1 ? "is" : "are"} Critical or High priority.` : ""}`}
        </p>
      </div>
      <div className="report-keep grid gap-5 lg:grid-cols-3">
        <div>
          <p className="mb-2 text-[12.5px] font-semibold">5a. Open defects by severity and ageing</p>
          <Table head={["Severity", ...AGE_BUCKETS, "Total"]} numeric={[1, 2, 3, 4, 5]}>
            {[...levels, "Total" as const].map((l) => {
              const cells = l === "Total" ? AGE_BUCKETS.map((_, i) => levels.reduce((t, x) => t + d.severityAge[x][i], 0)) : d.severityAge[l];
              return (
                <tr key={l} className={l === "Total" ? "font-semibold" : undefined}>
                  <td className={td}>{l}</td>
                  {cells.map((v, i) => (
                    <td key={i} className={num}>
                      {v}
                    </td>
                  ))}
                  <td className={`${num} font-semibold`}>{cells.reduce((t, v) => t + v, 0)}</td>
                </tr>
              );
            })}
          </Table>
        </div>
        <div>
          <p className="mb-2 text-[12.5px] font-semibold">5b. Open defects by priority</p>
          <Table head={["Priority", "Open defects"]} numeric={[1]}>
            {levels.map((l) => (
              <tr key={l}>
                <td className={td}>{l}</td>
                <td className={num}>{d.byPriority[l]}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className={td}>Total</td>
              <td className={num}>{d.open}</td>
            </tr>
          </Table>
        </div>
        <div>
          <p className="mb-2 text-[12.5px] font-semibold">5c. Retesting progress</p>
          <Table head={["Measure", "Count", "%"]} numeric={[1, 2]}>
            {retestRows.map((s) => (
              <tr key={s}>
                <td className={td}>{RETEST_LABEL[s]}</td>
                <td className={num}>{d.retest[s]}</td>
                <td className={num}>{formatPct(pct(d.retest[s], d.rows.length), 0)}</td>
              </tr>
            ))}
            <tr>
              <td className={td}>Failed results, no linked defect</td>
              <td className={clsx(num, d.failedWithoutDefect.length > 0 && "font-semibold text-red-600")}>{d.failedWithoutDefect.length}</td>
              <td className={num}>{d.failedChecked ? `${formatPct(pct(d.failedWithoutDefect.length, d.failedChecked), 0)} of ${d.failedChecked}` : "—"}</td>
            </tr>
          </Table>
        </div>
      </div>
      {d.rows.length > 0 && (
        <div>
          <p className="mb-2 text-[12.5px] font-semibold">5d. Defect register: severity and priority</p>
          <Table head={["ID", "Defect", "Module", "Status", "Severity", "Priority", "Age", "Owner"]} numeric={[6]}>
            {shown.map((r) => (
              <tr key={r.incident.incidentId} className={r.incident.open ? undefined : "text-slate-500"}>
                <td className={`${td} whitespace-nowrap`}>
                  <SpiraLink href={incidentUrl(r.incident.incidentId)}>IN:{r.incident.incidentId}</SpiraLink>
                </td>
                <td className={td}>{r.incident.name}</td>
                <td className={td}>{r.modules.join(", ") || "—"}</td>
                <td className={td}>{r.incident.status ?? "—"}</td>
                <td className={td}>{r.severity}</td>
                <td className={td}>{r.priority}</td>
                <td className={num}>{r.ageDays === null ? "—" : `${r.ageDays} d`}</td>
                <td className={td}>{r.incident.owner ?? "—"}</td>
              </tr>
            ))}
          </Table>
          {d.rows.length > shown.length && <p className="mt-2 text-[11.5px] text-slate-500">{d.rows.length - shown.length} more in the Excel export.</p>}
        </div>
      )}
    </>
  );
}

const FINDING_COLOR = { High: "#dc2626", Medium: "#d97706", Low: "#64748b" } as const;

function AssessmentPage({ report }: { report: Report }) {
  const { narrative } = report;
  return (
    <>
      <div>
        <Heading note="Checks that the Spira data behind this report is complete and consistent.">6. Data integrity and test-management hygiene</Heading>
        {report.findings.length === 0 ? (
          <p className="text-[12.5px] text-emerald-700">No issues found: every failure has a defect, counts agree, and every module has started.</p>
        ) : (
          <Table head={["Severity", "Check", "Applies to", "Detail"]}>
            {report.findings.map((f) => (
              <tr key={f.check}>
                <td className={td}>
                  <Pill color={FINDING_COLOR[f.severity]}>{f.severity}</Pill>
                </td>
                <td className={`${td} font-medium`}>{f.check}</td>
                <td className={td}>{f.appliesTo}</td>
                <td className={td}>{f.detail}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      {narrative.actions.length > 0 && (
        <div>
          <Heading>7. Key risks and actions</Heading>
          <div className="flex flex-col gap-2.5">
            {narrative.actions.map((a) => (
              <div key={a.title} className="report-keep rounded-lg border border-slate-200 px-3 py-2 text-[12.5px] leading-relaxed">
                <span className="font-semibold">{a.title}. </span>
                {a.detail} <span className="font-semibold text-slate-900">Action: </span>
                {a.action}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="report-keep">
        <Heading>8. QA assessment</Heading>
        <p className="mb-3 text-[13px] font-semibold" style={{ color: RAG[report.status].color }}>
          {RAG[report.status].label[0] + RAG[report.status].label.slice(1).toLowerCase()}: {report.status === "green" ? "ready to sign off." : "not yet ready to sign off."}{" "}
          <span className="font-normal text-slate-700">{report.statusReason}</span>
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg bg-emerald-50 px-3 py-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-emerald-800 uppercase">What is working</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-slate-800">
              {narrative.working.length ? narrative.working.map((w) => <li key={w}>{w}</li>) : <li>Nothing has completed yet.</li>}
            </ul>
          </div>
          <div className="rounded-lg bg-amber-50 px-3 py-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-amber-800 uppercase">Where the risk is</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[12px] leading-relaxed text-slate-800">
              {narrative.risks.length ? narrative.risks.map((r) => <li key={r}>{r}</li>) : <li>No open risks found in the Spira data.</li>}
            </ul>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-slate-700 uppercase">Recommendations</p>
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[12px] leading-relaxed text-slate-800">
              {narrative.actions.length ? narrative.actions.map((a) => <li key={a.title}>{a.action}</li>) : <li>Proceed to sign-off.</li>}
            </ol>
          </div>
        </div>
        {report.notes && (
          <div className="mt-3 rounded-lg border border-slate-200 px-3 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-line text-slate-800">
            <span className="font-semibold">QA notes. </span>
            {report.notes}
          </div>
        )}
      </div>
    </>
  );
}

function AppendixPage({ report, siteUrl }: { report: Report; siteUrl: string | null }) {
  const link = (path: string) => (siteUrl ? `${siteUrl}/${report.projectId}/${path}` : null);
  const failed = report.failedCases.slice(0, 200);
  return (
    <>
      <div>
        <Heading note="Every test set in scope with Spira's own counts. Overdue = planned date passed with cases still to run.">Appendix A. Test sets in scope</Heading>
        <Table head={["Test set", "Module", "Platform", "Folder", "Status", "Owner", "Planned", "Last run", "Pass", "Fail", "Block", "Not run", "Total"]} numeric={[8, 9, 10, 11, 12]}>
          {report.testSets.map((r) => (
            <tr key={r.set.testSetId}>
              <td className={td}>
                <SpiraLink href={link(`TestSet/${r.set.testSetId}.aspx`)}>{r.set.name}</SpiraLink>
              </td>
              <td className={td}>{r.module}</td>
              <td className={td}>{r.stream}</td>
              <td className={td}>{r.folder}</td>
              <td className={td}>{r.set.status ?? "—"}</td>
              <td className={td}>{r.set.owner ?? "—"}</td>
              <td className={clsx(td, "whitespace-nowrap", r.overdue && "font-semibold text-red-600")}>{dateText(r.set.plannedDate)}</td>
              <td className={`${td} whitespace-nowrap`}>{dateText(r.set.executionDate)}</td>
              <td className={num}>{r.set.counts.passed}</td>
              <td className={num}>{r.set.counts.failed}</td>
              <td className={num}>{r.set.counts.blocked}</td>
              <td className={num}>{r.set.counts.notRun}</td>
              <td className={num}>{r.spiraTotal}</td>
            </tr>
          ))}
        </Table>
      </div>
      {failed.length > 0 && (
        <div>
          <Heading note="Failed in scope, with the defects Spira links to each case.">Appendix B. Failed test cases</Heading>
          <Table head={["Test case", "Name", "Module", "Failed on", "Defects"]}>
            {failed.map((c) => (
              <tr key={`${c.module}:${c.testCaseId}`}>
                <td className={`${td} whitespace-nowrap`}>
                  <SpiraLink href={link(`TestCase/${c.testCaseId}.aspx`)}>TC:{c.testCaseId}</SpiraLink>
                </td>
                <td className={td}>{c.name}</td>
                <td className={td}>{c.module}</td>
                <td className={td}>{c.streams.join(", ")}</td>
                <td className={clsx(td, c.checked && c.incidentIds.length === 0 && "font-semibold text-red-600")}>
                  {!c.checked ? "Not checked" : c.incidentIds.length ? c.incidentIds.map((id) => `IN:${id}`).join(", ") : "None linked"}
                </td>
              </tr>
            ))}
          </Table>
          {report.failedCases.length > failed.length && <p className="mt-2 text-[11.5px] text-slate-500">{report.failedCases.length - failed.length} more in the Excel export.</p>}
        </div>
      )}
    </>
  );
}

export function ReportDocument({ report, changes, siteUrl }: { report: Report; changes: ReportChanges | null; siteUrl: string | null }) {
  const pages = [
    <SummaryPage key="summary" report={report} />,
    <ReadinessPage key="readiness" report={report} />,
    <ModulesPage key="modules" report={report} changes={changes} />,
    <ScopePage key="scope" report={report} />,
    <DefectsPage key="defects" report={report} siteUrl={siteUrl} />,
    <AssessmentPage key="assessment" report={report} />,
    <AppendixPage key="appendix" report={report} siteUrl={siteUrl} />,
  ];
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
