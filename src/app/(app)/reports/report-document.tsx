import clsx from "clsx";
import type { ReactNode } from "react";
import {
  AGE_BUCKETS,
  formatPct,
  LEVELS,
  MODULE_STATUS_LABEL,
  pct,
  RETEST_LABEL,
  splitText,
  type ChangeRow,
  type DefectPhase,
  type Level,
  type ModuleRow,
  type ModuleStatus,
  type PlatformSplit,
  type RagStatus,
  type Report,
  type RetestState,
} from "@/lib/domain/report";
import { Donut, OUTCOME_COLOR, OutcomeBar, OutcomeLegend, TargetBar, TrendChart } from "./charts";

const RAG: Record<RagStatus, { label: string; dot: string; pill: string }> = {
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

const MODULE_STATUS_COLOR: Record<ModuleStatus, string> = {
  ready: "#16a34a",
  atRisk: "#dc2626",
  inProgress: "#4f46e5",
  notStarted: "#94a3b8",
};

const LEVEL_CHIP: Record<Level, string> = {
  Critical: "bg-red-900 text-white",
  High: "bg-red-600 text-white",
  Medium: "bg-amber-400 text-amber-950",
  Low: "bg-sky-100 text-sky-900",
  "Not set": "bg-slate-200 text-slate-600",
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
const goLiveText = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export interface ReportChanges {
  since: string;
  rows: ChangeRow[];
}

/** "SIT" from "SIT Cycle 2", for "SIT exit criteria". */
function exitWord(report: Report): string {
  return /^[A-Z]{2,5}\b/.exec(report.environment)?.[0] ?? "";
}

function PageHead({ report }: { report: Report }) {
  const rag = RAG[report.status];
  const subtitle = [
    `${report.scopedName}${report.streams.length ? ` (${report.streams.join(", ")})` : ""}`,
    `Report date ${dateText(report.generatedAt)}`,
    report.window.text ? `Executions ${report.window.text}` : null,
    report.goLive
      ? `Go-live ${goLiveText(report.goLive)}${report.daysToGoLive !== null ? ` (${report.daysToGoLive >= 0 ? `${report.daysToGoLive} days` : `${-report.daysToGoLive} days ago`})` : ""}`
      : null,
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

function PageFoot({ report, page, pages }: { report: Report; page: number; pages: number }) {
  return (
    <footer className="mt-6 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-2 text-[10.5px] text-slate-500">
      <span>
        {report.preparedBy && `Prepared by ${report.preparedBy} · `}Source: SpiraTest ({report.projectName}), {report.scopedName}
        {report.scopedLabel !== report.scopedName && `, ${report.scopedLabel}`}
        {report.hasBaseline && `; total plan from ${report.baselineLabel}`} · Read live {dateTimeText(report.generatedAt)}
      </span>
      <span>
        Page {page} / {pages}
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

function SubHeading({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-[12.5px] font-semibold text-slate-900">{children}</p>;
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
const totalNum = `${totalCell} text-right tabular-nums`;

function Pill({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="inline-block rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide whitespace-nowrap text-white uppercase"
      style={{ background: color }}
    >
      {children}
    </span>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return <span className={clsx("inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", className)}>{children}</span>;
}

function Tick({ value }: { value: boolean | null }) {
  if (value === null) return <span className="text-slate-400">—</span>;
  return value ? <span className="font-bold text-emerald-600">✓</span> : <span className="font-bold text-red-600">✗</span>;
}

function Kpi({ label, value, hint, split, color }: { label: string; value: ReactNode; hint?: ReactNode; split?: ReactNode; color: string }) {
  return (
    <div className="rounded-lg border border-slate-200 border-t-4 bg-white px-3 py-2.5" style={{ borderTopColor: color }}>
      <p className="text-[10.5px] font-semibold tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-0.5 text-2xl leading-tight font-bold tabular-nums" style={{ color }}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-slate-600">{hint}</p>}
      {split && <p className="mt-1 border-t border-slate-100 pt-1 text-[10.5px] text-slate-500 tabular-nums">{split}</p>}
    </div>
  );
}

function Panel({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-200 p-3">
      <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      <div className="mt-2 flex-1">{children}</div>
      {foot && <div className="mt-2 text-[11px] leading-snug text-slate-500">{foot}</div>}
    </div>
  );
}

function Swatch({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[2px]" style={{ background: color }} />
      {label} <span className="font-semibold text-slate-800 tabular-nums">{n(value)}</span>
    </span>
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

function PlatformLine({ report, split }: { report: Report; split: PlatformSplit }) {
  return report.streams.length > 1 ? <>{splitText(split, report.streams)}</> : null;
}

// ---------------------------------------------------------------------------------------------
// Page 1: summary and total plan vs this build

function SummaryPage({ report }: { report: Report }) {
  const k = report.kpis;
  const { labels, hasBaseline } = report;
  const planned = report.kind === "planned";
  const exit = exitWord(report);
  const notStarted = report.modules.filter((m) => m.status === "notStarted").length;
  const blockedOrCaution = (["blocked", "caution"] as const).filter((o) => k.outcomes[o] > 0);
  const tiles = [
    hasBaseline && (
      <Kpi
        key="plan"
        label="Total test plan"
        value={n(k.plan)}
        hint={`All ${k.modulesInPlan} module${k.modulesInPlan === 1 ? "" : "s"}`}
        split={<PlatformLine report={report} split={k.split.plan} />}
        color="#334155"
      />
    ),
    <Kpi
      key="build"
      label={labels.build}
      value={n(k.inScope)}
      hint={hasBaseline ? `${formatPct(k.planPct)} of total plan` : `${report.modules.length} module${report.modules.length === 1 ? "" : "s"}`}
      split={<PlatformLine report={report} split={k.split.inScope} />}
      color="#4f46e5"
    />,
    <Kpi
      key="executed"
      label="Executed"
      value={n(k.executed)}
      hint={`${formatPct(k.execPct)} of ${labels.name}`}
      split={<PlatformLine report={report} split={k.split.executed} />}
      color="#0369a1"
    />,
    <Kpi
      key="passed"
      label="Passed"
      value={n(k.outcomes.passed)}
      hint={`${formatPct(k.passPct)} pass rate`}
      split={<PlatformLine report={report} split={k.split.passed} />}
      color="#15803d"
    />,
    <Kpi
      key="defects-today"
      label="Defects today"
      value={n(report.defects.today.length)}
      hint={
        report.defects.today.length
          ? `${report.defects.today.filter((r) => r.source === "spira").length} Spira · ${report.defects.today.filter((r) => r.source === "app" || r.alsoInApp).length} in this app`
          : "Spira + this app"
      }
      color="#b91c1c"
    />,
    <Kpi key="open-defects" label="All-time defects" value={n(report.defects.everOpened)} color="#b91c1c" />,
    <Kpi
      key="left"
      label="Still to run"
      value={n(k.stillToRun)}
      hint={notStarted ? `${notStarted} module${notStarted === 1 ? "" : "s"} not started` : k.stillToRun ? "All modules started" : "Everything run"}
      split={<PlatformLine report={report} split={k.split.stillToRun} />}
      color="#b45309"
    />,
  ].filter(Boolean);

  const buildShare = hasBaseline && k.plan ? Math.min(1, k.inScope / k.plan) : 1;
  const executedShare = k.plan ? Math.min(1, k.executed / k.plan) : 0;
  const cycleRows: Array<[string, string, string]> =
    !planned && hasBaseline && k.baseline.executed > 0
      ? [
          ["Pass rate", formatPct(k.baseline.passPct), formatPct(k.passPct)],
          ["Blocked tests", n(k.baseline.outcomes.blocked), n(k.outcomes.blocked)],
        ]
      : [];

  return (
    <>
      {planned && (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[12.5px] leading-relaxed text-slate-700">
          Planned test cases for {labels.name}: execution has not started. Executed, passed, defects today, and other defect figures are shown as zero.
        </p>
      )}
      <div
        className={clsx(
          "grid grid-cols-2 gap-2.5 sm:grid-cols-3",
          tiles.length >= 7 ? "xl:grid-cols-7" : tiles.length === 6 ? "xl:grid-cols-6" : "xl:grid-cols-5",
        )}
      >
        {tiles}
      </div>

      <div className={clsx("report-keep grid gap-3", planned ? "sm:grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
        {!planned && (
          <>
            <Panel
              title="Execution status"
              foot={
                <>
                  {n(k.executed)} of {n(k.executable)} test runs in {labels.name}
                  <br />
                  Target at {exit ? `${exit} ` : ""}exit: {report.targets.executedPct}%
                </>
              }
            >
              <div className="flex items-center gap-3">
                <Donut
                  segments={(["passed", "failed", "blocked", "caution", "notRun"] as const).map((o) => ({ value: k.outcomes[o], color: OUTCOME_COLOR[o] }))}
                  center={
                    <span>
                      <span className="block text-lg font-bold tabular-nums">{formatPct(k.execPct)}</span>
                      <span className="block px-3 text-[9.5px] leading-tight text-slate-500">of {labels.name} executed</span>
                    </span>
                  }
                />
                <div className="flex flex-col gap-1 text-[11px] text-slate-600">
                  <Swatch color={OUTCOME_COLOR.passed} label="Passed" value={k.outcomes.passed} />
                  <Swatch color={OUTCOME_COLOR.failed} label="Failed" value={k.outcomes.failed} />
                  {blockedOrCaution.map((o) => (
                    <Swatch key={o} color={OUTCOME_COLOR[o]} label={o === "blocked" ? "Blocked" : "Caution"} value={k.outcomes[o]} />
                  ))}
                  <Swatch color={OUTCOME_COLOR.notRun} label="Still to run" value={k.stillToRun} />
                </div>
              </div>
            </Panel>
            <Panel title="Outcome of executed tests" foot={`Target at ${exit ? `${exit} ` : ""}exit: ${report.targets.passRatePct}% pass`}>
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
                <div className="flex flex-col gap-1 text-[11px] text-slate-600">
                  <Swatch color={OUTCOME_COLOR.passed} label="Passed" value={k.outcomes.passed} />
                  <Swatch color={OUTCOME_COLOR.failed} label="Failed" value={k.outcomes.failed} />
                  <Swatch color={OUTCOME_COLOR.blocked} label="Blocked" value={k.outcomes.blocked} />
                  <Swatch color={OUTCOME_COLOR.caution} label="Caution" value={k.outcomes.caution} />
                </div>
              </div>
            </Panel>
            <Panel
              title="Modules ready for UAT"
              foot="Ready = every run executed. In progress = at least half run. At risk = started but under half executed."
            >
              <div className="flex items-center gap-3">
                <Donut
                  segments={(Object.keys(MODULE_STATUS_COLOR) as ModuleStatus[]).map((s) => ({
                    value: report.readiness[s],
                    color: MODULE_STATUS_COLOR[s],
                  }))}
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
                  {(Object.keys(MODULE_STATUS_COLOR) as ModuleStatus[])
                    .filter((s) => s !== "inProgress" || report.readiness.inProgress > 0)
                    .map((s) => (
                      <Swatch key={s} color={MODULE_STATUS_COLOR[s]} label={MODULE_STATUS_LABEL[s]} value={report.readiness[s]} />
                    ))}
                </div>
              </div>
            </Panel>
          </>
        )}
        {hasBaseline ? (
          <Panel
            title={planned ? "Total test plan vs planned build" : "Total test plan vs this build"}
            foot={
              report.streams.length > 1 ? `Test runs across ${report.streams.join(" and ")}: each case counted once per platform.` : "Each case counted once."
            }
          >
            <div className="relative mt-1 h-4 w-full overflow-hidden rounded-sm bg-slate-200">
              <div className="absolute inset-y-0 left-0 bg-indigo-300" style={{ width: `${buildShare * 100}%` }} />
              {!planned && <div className="absolute inset-y-0 left-0 bg-indigo-600" style={{ width: `${executedShare * 100}%` }} />}
            </div>
            <div className="relative h-0">
              <div className="absolute -top-5 h-6 w-0.5 bg-slate-900" style={{ left: `calc(${buildShare * 100}% - 1px)` }} />
            </div>
            <div className="mt-1 flex justify-between gap-2 text-[10.5px] text-slate-600">
              <span>
                ◀ {labels.build}: {n(k.inScope)} ({formatPct(k.planPct)})
              </span>
              <span>Later builds: {n(k.laterBuilds)} ▶</span>
            </div>
            <table className="mt-2 w-full text-[11px]">
              <tbody>
                {(
                  [
                    ["Total test plan", n(k.plan), ""],
                    ["Later builds", n(k.laterBuilds), `${formatPct(pct(k.laterBuilds, k.plan))} of plan`],
                    [labels.build, n(k.inScope), `${formatPct(k.planPct)} of plan`],
                    ["Executed", n(k.executed), planned ? "Not started" : `${formatPct(k.execPct)} of build`],
                    ["Still to run", n(k.stillToRun), notStarted ? `${notStarted} module${notStarted === 1 ? "" : "s"} not started` : ""],
                  ] as const
                ).map(([label, value, hint]) => (
                  <tr key={label}>
                    <td className="py-0.5 text-slate-600">{label}</td>
                    <td className="py-0.5 text-right font-semibold tabular-nums">{value}</td>
                    <td className="py-0.5 pl-2 text-right text-slate-500">{hint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cycleRows.length > 0 && (
              <div className="mt-2 border-t border-slate-100 pt-1.5">
                <p className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
                  {report.baselineName} → {report.scopedName}
                </p>
                {cycleRows.map(([label, before, now]) => (
                  <p key={label} className="flex justify-between text-[11px]">
                    <span className="text-slate-600">{label}</span>
                    <span className="tabular-nums">
                      {before} → <span className="font-semibold">{now}</span>
                    </span>
                  </p>
                ))}
              </div>
            )}
          </Panel>
        ) : (
          <Panel title={planned ? "Planned by platform" : "Progress by platform"}>
            <div className="flex flex-col gap-2.5">
              {report.streamRows.map((s) => (
                <div key={s.stream}>
                  <div className="flex justify-between text-[11.5px]">
                    <span className="font-medium">{s.stream}</span>
                    <span className="text-slate-600 tabular-nums">
                      {planned ? `${n(s.total)} planned` : `${formatPct(s.execPct, 0)} run · ${n(s.executed)} / ${n(s.total)}`}
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
        )}
        {planned && (
          <Panel title="Modules in this plan" foot={`${report.modules.length} module${report.modules.length === 1 ? "" : "s"} with planned runs; none started.`}>
            <div className="flex flex-col gap-1.5 text-[11.5px] text-slate-700">
              {report.modules.map((m) => (
                <div key={m.id} className="flex justify-between gap-2">
                  <span className="truncate font-medium">{m.name}</span>
                  <span className="shrink-0 tabular-nums text-slate-500">
                    {n(m.inScope)} · {m.streams.join(" · ") || "—"}
                  </span>
                </div>
              ))}
              {report.laterModules.length > 0 && (
                <p className="mt-1 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">
                  Later builds: {report.laterModules.map((m) => m.name).join(", ")}
                </p>
              )}
            </div>
          </Panel>
        )}
      </div>

      {report.notes && (
        <div className="rounded-lg border-l-4 border-slate-900 bg-slate-50 px-4 py-2.5 text-[12.5px] leading-relaxed whitespace-pre-line text-slate-800">
          {report.notes}
        </div>
      )}

      <PlanTable report={report} />
    </>
  );
}

function PlanTable({ report }: { report: Report }) {
  const k = report.kpis;
  const { labels, hasBaseline } = report;
  const planned = report.kind === "planned";
  const plat = report.streams.length > 1 ? ` × ${report.streams.length} platforms` : "";
  const footnote = [
    hasBaseline
      ? `Total plan = every case in ${report.baselineName}${plat} (${splitText(k.split.plan, report.streams)}). ${labels.build} = ${splitText(k.split.inScope, report.streams)}${
          k.added ? `, including ${n(k.added)} run${k.added === 1 ? "" : "s"} added in testing` : ""
        }.`
      : `Each case counts once per platform it is planned on (${splitText(k.split.inScope, report.streams)}).`,
    !planned && hasBaseline && k.baseline.executed ? `${report.baselineName} pass rate = ${n(k.baseline.outcomes.passed)} of ${n(k.baseline.executed)} executed.` : "",
    k.api.inScope
      ? planned
        ? `API cases (${n(k.api.inScope)}) are not platform runs and are left out of these totals.`
        : `API cases (${n(k.api.inScope)}, ${n(k.api.passed)} passed, ${n(k.api.failed)} failed) are not platform runs and are left out of these totals.`
      : "",
    !planned && k.outcomes.caution ? `${n(k.outcomes.caution)} run${k.outcomes.caution === 1 ? "" : "s"} passed with caution count as executed.` : "",
    planned ? "Executed / passed / failed columns are zero because this is a planned-cases document." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const head = planned
    ? ["Module", "Platforms", ...(hasBaseline ? ["Total plan"] : []), labels.build, ...(hasBaseline ? ["Later builds"] : []), "Still to run"]
    : [
        "Module",
        ...(hasBaseline ? ["Total plan"] : []),
        labels.build,
        ...(hasBaseline ? ["Later builds"] : []),
        "Executed",
        "Passed",
        "Failed",
        "Blocked",
        "Still to run",
        "Pass %",
        "Build done",
      ];
  const row = (m: ModuleRow) => (
    <tr key={m.id} className={m.inBuild ? undefined : "text-slate-400"}>
      <td className={clsx(td, "font-medium")}>{m.inBuild ? m.name : `${m.name} (not in ${labels.name})`}</td>
      {planned && <td className={`${td} whitespace-nowrap`}>{m.streams.join(" · ") || "—"}</td>}
      {hasBaseline && <td className={num}>{n(m.plan)}</td>}
      <td className={num}>{m.inBuild ? n(m.inScope) : "—"}</td>
      {hasBaseline && <td className={num}>{n(m.laterBuilds)}</td>}
      {planned ? (
        <td className={num}>{m.inBuild ? n(m.stillToRun) : "—"}</td>
      ) : m.inBuild ? (
        <>
          <td className={num}>{n(m.executed)}</td>
          <td className={num}>{n(m.outcomes.passed)}</td>
          <td className={clsx(num, m.outcomes.failed > 0 && "font-semibold text-red-700")}>{n(m.outcomes.failed)}</td>
          <td className={clsx(num, m.outcomes.blocked > 0 && "font-semibold text-orange-600")}>{n(m.outcomes.blocked)}</td>
          <td className={num}>{n(m.stillToRun)}</td>
          <td className={num}>{formatPct(m.passPct)}</td>
          <td className={clsx(num, m.execPct === 100 && "font-semibold text-emerald-700")}>{formatPct(m.execPct)}</td>
        </>
      ) : (
        Array.from({ length: 7 }, (_, i) => (
          <td key={i} className={num}>
            —
          </td>
        ))
      )}
    </tr>
  );
  return (
    <div>
      <Heading>{hasBaseline ? `1. Total test plan vs ${labels.name}: by module` : `1. ${labels.build}: by module`}</Heading>
      <Table
        head={head}
        numeric={Array.from({ length: head.length - 1 }, (_, i) => i + 1)}
        foot={
          <tr>
            <td className={totalCell}>Total</td>
            {planned && <td className={totalCell}>{report.streams.join(" · ")}</td>}
            {hasBaseline && <td className={totalNum}>{n(k.plan)}</td>}
            <td className={totalNum}>{n(k.inScope)}</td>
            {hasBaseline && <td className={totalNum}>{n(k.laterBuilds)}</td>}
            {planned ? (
              <td className={totalNum}>{n(k.stillToRun)}</td>
            ) : (
              <>
                {[k.executed, k.outcomes.passed, k.outcomes.failed, k.outcomes.blocked, k.stillToRun].map((v, i) => (
                  <td key={i} className={totalNum}>
                    {n(v)}
                  </td>
                ))}
                <td className={totalNum}>{formatPct(k.passPct)}</td>
                <td className={totalNum}>{formatPct(k.execPct)}</td>
              </>
            )}
          </tr>
        }
      >
        {report.modules.map(row)}
        {report.laterModules.map(row)}
      </Table>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{footnote}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Page 2: exit criteria and outcome by module

function ReadinessPage({ report }: { report: Report }) {
  const exit = exitWord(report);
  const asOf = dateText(report.window.last ?? report.generatedAt, false);
  const byRun = [...report.modules].sort((a, b) => b.executed - a.executed || (b.execPct ?? 0) - (a.execPct ?? 0) || a.name.localeCompare(b.name));
  return (
    <>
      <div>
        <Heading note={`${report.statusReason} Bars show actual progress; the dark marker is the target.`}>
          2. Readiness against {exit ? `${exit} ` : ""}exit criteria
        </Heading>
        <div className="report-keep mb-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {report.bars.map((b) => {
            const good = b.met || Boolean(b.soft);
            return (
              <div key={b.label}>
                <div className="flex justify-between gap-2 text-[11.5px]">
                  <span className="font-medium">{b.label}</span>
                  <span className={clsx("tabular-nums", good ? "text-emerald-700" : "text-red-700")}>{b.text}</span>
                </div>
                <div className="mt-1">
                  <TargetBar progress={b.progress} mark={b.mark} met={good} />
                </div>
              </div>
            );
          })}
        </div>
        <Table head={["#", "Exit criterion", "Target", `Actual (${asOf})`, "Status"]}>
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
        <Heading
          note={`Share of each module's test runs by result${report.streams.length > 1 ? `, across ${report.streams.join(" and ")}` : ""}. Sorted by how much has been run.`}
        >
          3a. Test outcome by module
        </Heading>
        <div className="mb-2">
          <OutcomeLegend show={["passed", "failed", "blocked", "caution", "notRun"]} />
        </div>
        <div className="flex flex-col gap-2">
          {byRun.map((m) => (
            <div key={m.id} className="report-keep grid grid-cols-[minmax(7rem,11rem)_1fr_minmax(10rem,13rem)] items-center gap-3 text-[12px]">
              <span className="truncate font-medium">{m.name}</span>
              <OutcomeBar counts={m.outcomes} height={14} show={["passed", "failed", "blocked", "caution", "notRun"]} />
              <span className="text-slate-600 tabular-nums">
                {n(m.executed)}/{n(m.executable)} run
                {m.executed > 0 ? ` · ${formatPct(m.passPct)} pass` : " · not started"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Page 3: module readiness and change since the baseline cycle

function ModulesPage({ report, changes }: { report: Report; changes: ReportChanges | null }) {
  const target = report.targets.passRatePct;
  const k = report.kpis;
  const changeRows = report.cycle?.rows ?? changes?.rows ?? null;
  return (
    <>
      <div>
        <Heading note="Ready = every planned run executed. In progress = at least half of the module’s runs done. At risk = started but under half executed (e.g. 1 of 56). Pass rate, blocked tests and open defects stay in the columns.">
          3b. Module readiness for UAT
        </Heading>
        <Table
          head={[
            "Module",
            "Platforms",
            "In scope",
            "Executed",
            "Exec %",
            "Passed",
            "Failed",
            "Blocked",
            "Pass %",
            "100% run",
            `Pass ≥${target}%`,
            "0 blocked",
            "Defects",
            "UAT status",
          ]}
          numeric={[2, 3, 4, 5, 6, 7, 8]}
          foot={
            <tr>
              <td className={totalCell}>Total</td>
              <td className={totalCell}>{report.streams.join(" · ")}</td>
              <td className={totalNum}>{n(k.inScope)}</td>
              <td className={totalNum}>{n(k.executed)}</td>
              <td className={totalNum}>{formatPct(k.execPct)}</td>
              <td className={totalNum}>{n(k.outcomes.passed)}</td>
              <td className={totalNum}>{n(k.outcomes.failed)}</td>
              <td className={totalNum}>{n(k.outcomes.blocked)}</td>
              <td className={totalNum}>{formatPct(k.passPct)}</td>
              <td className={totalCell} colSpan={3} />
              <td className={totalCell}>{report.defects.open} open</td>
              <td className={totalCell}>
                {report.readiness.ready} of {report.modules.length} ready
              </td>
            </tr>
          }
        >
          {report.modules.map((m) => (
            <tr key={m.id}>
              <td className={`${td} font-medium`}>{m.name}</td>
              <td className={`${td} whitespace-nowrap`}>{m.streams.join(" · ")}</td>
              <td className={num}>{n(m.inScope)}</td>
              <td className={num}>{n(m.executed)}</td>
              <td className={num}>{formatPct(m.execPct)}</td>
              <td className={num}>{n(m.outcomes.passed)}</td>
              <td className={clsx(num, m.outcomes.failed > 0 && "font-semibold text-red-700")}>{n(m.outcomes.failed)}</td>
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
        {report.narrative.why.length > 0 && (
          <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-700">
            <p className="font-semibold text-slate-900">Why each module has this status</p>
            {report.narrative.why.map((line) => (
              <p key={line} className="mt-1">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          {report.cycle ? (
            <Heading>
              3c. Change since {report.cycle.baselineName} ({report.cycle.stream} test sets)
            </Heading>
          ) : (
            <Heading
              note={
                changes
                  ? `Compared with the report read on ${dateTimeText(changes.since)} for the same scope, kept in this browser. Choose a baseline to compare with the previous cycle instead.`
                  : "Choose a baseline (the previous cycle) to compare cycles, or generate again tomorrow to see what moved since today."
              }
            >
              3c. Change since the last report
            </Heading>
          )}
          {changeRows && (
            <Table
              head={
                report.cycle
                  ? ["Module", `${report.cycle.baselineName} (${report.cycle.stream})`, `${report.cycle.scopedName} (${report.cycle.stream})`, "Movement"]
                  : ["Module", `${dateText(changes!.since, false)} report`, dateText(report.generatedAt, false), "Movement"]
              }
            >
              {changeRows.map((r) => (
                <tr key={r.name}>
                  <td className={`${td} font-medium`}>{r.name}</td>
                  <td className={td}>{r.before}</td>
                  <td className={td}>{r.now}</td>
                  <td className={clsx(td, "font-semibold", r.tone === "good" ? "text-emerald-700" : r.tone === "bad" ? "text-red-700" : "text-slate-600")}>
                    {r.movement}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <div className="flex flex-col gap-3 text-[12px] leading-relaxed text-slate-700">
          <div className="rounded-lg border border-slate-200 px-3 py-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Scope note</p>
            <p className="mt-1">{report.narrative.scopeNote}</p>
          </div>
          <div className="rounded-lg border border-slate-200 px-3 py-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Data note</p>
            <p className="mt-1">{report.narrative.dataNote}</p>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Page 4: defects, retesting, risks and actions

const PHASE_CHIP: Record<DefectPhase, string> = {
  in: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200",
  out: "bg-slate-100 text-slate-700 ring-1 ring-slate-300",
  tbc: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
};

function DefectsPage({ report, siteUrl }: { report: Report; siteUrl: string | null }) {
  const d = report.defects;
  const { labels } = report;
  const levels = LEVELS.filter((l) => l !== "Not set" || d.severityAge[l].some(Boolean) || d.byPriority[l]);
  const incidentUrl = (id: number) => (siteUrl ? `${siteUrl}/${report.projectId}/Incident/${id}.aspx` : null);
  const retestRows: RetestState[] = ["retest", "closed", "reopened", "awaiting"];
  const phaseText: Record<DefectPhase, string> = {
    in: labels.inBuild,
    out: labels.outside,
    tbc: "To confirm",
  };
  const registerRows = d.registerRows;
  const shown = registerRows.slice(0, 60);
  const openRows = d.registerOpen;
  const openShown = openRows.slice(0, 120);
  const actions = report.narrative.actions;
  const todayShown = d.today.slice(0, 80);
  return (
    <>
      <div>
        <Heading>4. Defects and retesting</Heading>
        <p className="text-[12.5px] leading-relaxed text-slate-700">{d.summary}</p>
      </div>
      <div>
        <SubHeading>Defects captured today</SubHeading>
        <p className="mb-2 text-[11.5px] text-slate-500">
          Spira incidents created on this report day, plus defects logged in this app today (same IN: counted once).
        </p>
        {d.today.length === 0 ? (
          <p className="text-[12.5px] text-emerald-700">No defects captured today in Spira or this app.</p>
        ) : (
          <>
            <Table head={["ID", "Defect", "Source", "Status", "Open"]}>
              {todayShown.map((row) => (
                <tr key={row.key}>
                  <td className={td}>
                    {row.incidentId != null ? (
                      <SpiraLink href={incidentUrl(row.incidentId)}>IN:{row.incidentId}</SpiraLink>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={td}>{row.title}</td>
                  <td className={td}>
                    {row.source === "spira" ? (row.alsoInApp ? "Spira + app" : "Spira") : "This app"}
                  </td>
                  <td className={td}>{row.status ?? "—"}</td>
                  <td className={td}>{row.open ? "Yes" : "No"}</td>
                </tr>
              ))}
            </Table>
            {d.today.length > todayShown.length && (
              <p className="mt-2 text-[11.5px] text-slate-500">{d.today.length - todayShown.length} more in the Excel export.</p>
            )}
          </>
        )}
      </div>
      <div className="report-keep grid gap-5 lg:grid-cols-3">
        <div>
          <SubHeading>4a. Open defects by severity and ageing</SubHeading>
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
          <SubHeading>4b. Open defects by priority</SubHeading>
          <Table head={["Priority", "All defects", labels.inBuild]} numeric={[1, 2]}>
            {levels.map((l) => (
              <tr key={l}>
                <td className={td}>{l}</td>
                <td className={num}>{d.byPriority[l]}</td>
                <td className={num}>{d.byPriorityInBuild[l]}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className={td}>Total</td>
              <td className={num}>{d.open}</td>
              <td className={num}>{levels.reduce((t, l) => t + d.byPriorityInBuild[l], 0)}</td>
            </tr>
          </Table>
        </div>
        <div>
          <SubHeading>4c. Retesting progress</SubHeading>
          <Table head={["Measure", "Count", "%"]} numeric={[1, 2]}>
            {retestRows.map((s) => (
              <tr key={s}>
                <td className={td}>{RETEST_LABEL[s]}</td>
                <td className={num}>{d.retest[s]}</td>
                <td className={num}>{formatPct(pct(d.retest[s], d.rows.length), 0)}</td>
              </tr>
            ))}
            <tr>
              <td className={td}>Failed cases, no linked defect</td>
              <td className={clsx(num, d.failedWithoutDefect.length > 0 && "font-semibold text-red-700")}>{d.failedWithoutDefect.length}</td>
              <td className={num}>{d.failedChecked ? `${formatPct(pct(d.failedWithoutDefect.length, d.failedChecked), 0)} of ${d.failedChecked}` : "—"}</td>
            </tr>
          </Table>
        </div>
      </div>
      <div>
        <SubHeading>4d. Defect register: severity and priority</SubHeading>
        <p className="mb-2 text-[11.5px] text-slate-500">
          {d.registerName
            ? `From Review bucket “${d.registerName}” (API-linked defects omitted).`
            : "Pick a Defects Review bucket in report setup to fill this register."}
        </p>
        {registerRows.length === 0 ? (
          <p className="text-[12.5px] text-slate-500">
            {d.registerName ? "No non-API defects in this bucket." : "No Review bucket selected."}
          </p>
        ) : (
          <>
            <Table head={["ID", "Defect", "Feature", `${labels.short} scope`, "Severity", "Priority", "Rationale"]}>
              {shown.map((r) => (
                <tr key={r.incident.incidentId} className={r.incident.open ? undefined : "text-slate-500"}>
                  <td className={`${td} whitespace-nowrap`}>
                    <SpiraLink href={incidentUrl(r.incident.incidentId)}>IN:{r.incident.incidentId}</SpiraLink>
                  </td>
                  <td className={td}>{r.incident.name}</td>
                  <td className={td}>{r.feature || "—"}</td>
                  <td className={td}>
                    {r.phase ? <Chip className={PHASE_CHIP[r.phase]}>{phaseText[r.phase]}</Chip> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className={td}>
                    <Chip className={LEVEL_CHIP[r.severity]}>{r.severity}</Chip>
                  </td>
                  <td className={td}>
                    <Chip className={LEVEL_CHIP[r.priority]}>{r.priority}</Chip>
                  </td>
                  <td className={clsx(td, "text-[11.5px]")}>{r.rationale || <span className="text-slate-400">—</span>}</td>
                </tr>
              ))}
            </Table>
            {registerRows.length > shown.length && (
              <p className="mt-2 text-[11.5px] text-slate-500">{registerRows.length - shown.length} more in the Excel export.</p>
            )}
          </>
        )}
      </div>

      <div className="report-keep">
        <Heading>Key risks and actions</Heading>
        {actions.length ? (
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            {actions.map((a) => (
              <p key={a.title} className="text-[12.5px] leading-relaxed text-slate-700">
                <span className="font-semibold text-slate-900">{a.title}. </span>
                {a.detail} <span className="font-semibold text-slate-900">Action: </span>
                {a.action}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-emerald-700">No open risks found in the Spira data: every run is executed and passed, and no defect is open.</p>
        )}
      </div>

      <div className="report-keep">
        <Heading>
          Open defects
          {openRows.length ? ` (${n(openRows.length)})` : ""}
        </Heading>
        <p className="mb-2 text-[11.5px] text-slate-500">
          {d.registerName
            ? `Still open in Review bucket “${d.registerName}”.`
            : "Pick a Defects Review bucket in report setup to list open defects here."}
        </p>
        {openRows.length === 0 ? (
          <p className="text-[12.5px] text-emerald-700">No open defects in the Review bucket.</p>
        ) : (
          <>
            <Table head={["ID", "Defect", "Status", "Severity", "Priority", "Detected", "Age"]}>
              {openShown.map((r) => (
                <tr key={r.incident.incidentId}>
                  <td className={`${td} whitespace-nowrap`}>
                    <SpiraLink href={incidentUrl(r.incident.incidentId)}>IN:{r.incident.incidentId}</SpiraLink>
                  </td>
                  <td className={td}>{r.incident.name}</td>
                  <td className={td}>{r.incident.status ?? "Open"}</td>
                  <td className={td}>
                    <Chip className={LEVEL_CHIP[r.severity]}>{r.severity}</Chip>
                  </td>
                  <td className={td}>
                    <Chip className={LEVEL_CHIP[r.priority]}>{r.priority}</Chip>
                  </td>
                  <td className={td}>{r.incident.detectedRelease ?? "—"}</td>
                  <td className={num}>{r.ageDays !== null ? `${r.ageDays} d` : "—"}</td>
                </tr>
              ))}
            </Table>
            {openRows.length > openShown.length && (
              <p className="mt-2 text-[11.5px] text-slate-500">{openRows.length - openShown.length} more open defects in the Excel export.</p>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Appendix (optional)

const FINDING_COLOR = {
  High: "#dc2626",
  Medium: "#d97706",
  Low: "#64748b",
} as const;

function AppendixPage({ report, siteUrl }: { report: Report; siteUrl: string | null }) {
  const link = (path: string) => (siteUrl ? `${siteUrl}/${report.projectId}/${path}` : null);
  const failed = report.failedCases.slice(0, 200);
  return (
    <>
      <div>
        <Heading note="Checks that the Spira data behind this report is complete and consistent.">A. Data checks</Heading>
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
      <div className="report-keep">
        <Heading
          note={`Test runs by the day of their latest result (green passed or other result, red failed); the line is the running total executed${
            report.trend.earlier ? `, including ${n(report.trend.earlier)} run before this window` : ""
          }.${report.trend.pacePerDay ? ` Recent pace: about ${Math.round(report.trend.pacePerDay)} runs per active day` : ""}${
            report.trend.daysToFinish
              ? `; the ${n(report.kpis.stillToRun)} remaining need about ${report.trend.daysToFinish} more day${report.trend.daysToFinish === 1 ? "" : "s"}.`
              : "."
          }`}
        >
          B. Execution trend, last 21 days
        </Heading>
        <TrendChart days={report.trend.days} total={report.kpis.executable} />
      </div>
      <div>
        <Heading note="Every test set in scope with Spira's own counts. Overdue = planned date passed with cases still to run.">C. Test sets in scope</Heading>
        <Table
          head={["Test set", "Module", "Platform", "Folder", "Status", "Owner", "Planned", "Last run", "Pass", "Fail", "Block", "Not run", "Total"]}
          numeric={[8, 9, 10, 11, 12]}
        >
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
          <Heading note="Failed in scope, with the defects Spira links to each case.">D. Failed test cases</Heading>
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
          {report.failedCases.length > failed.length && (
            <p className="mt-2 text-[11.5px] text-slate-500">{report.failedCases.length - failed.length} more in the Excel export.</p>
          )}
        </div>
      )}
      {report.hasBaseline && report.scope.added.length > 0 && (
        <div>
          <Heading note="Usually cases written during testing, for example for a defect. Add them to the baseline if they should stay.">
            E. Cases in scope but not in the baseline
          </Heading>
          <p className="text-[12px] leading-relaxed text-slate-700">
            {report.scope.added
              .slice(0, 60)
              .map((c) => `TC:${c.testCaseId} ${c.name} (${c.module})`)
              .join(" · ")}
            {report.scope.added.length > 60 && ` · and ${report.scope.added.length - 60} more in the Excel export`}
          </p>
        </div>
      )}
    </>
  );
}

function PlannedScopePage({ report }: { report: Report }) {
  const { labels } = report;
  return (
    <>
      <div>
        <Heading note="What is in this build’s plan, and what stays for later builds.">2. Planned scope</Heading>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-700">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Scope note</p>
            <p className="mt-1">{report.narrative.scopeNote || `Cases planned for ${labels.name}.`}</p>
          </div>
          <div className="rounded-lg border border-slate-200 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-700">
            <p className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">Data note</p>
            <p className="mt-1">{report.narrative.dataNote}</p>
          </div>
        </div>
        {report.narrative.why.length > 0 && (
          <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2.5 text-[12px] leading-relaxed text-slate-700">
            <p className="font-semibold text-slate-900">Modules planned</p>
            {report.narrative.why.map((line) => (
              <p key={line} className="mt-1">
                {line}
              </p>
            ))}
          </div>
        )}
      </div>
      {report.hasBaseline && (report.scope.added.length > 0 || report.scope.deferred.length > 0) && (
        <div className="report-keep grid gap-4 md:grid-cols-2">
          {report.scope.added.length > 0 && (
            <div>
              <SubHeading>In {labels.name}, not in the total plan</SubHeading>
              <p className="text-[12px] leading-relaxed text-slate-700">
                {report.scope.added
                  .slice(0, 40)
                  .map((c) => `TC:${c.testCaseId} ${c.name}`)
                  .join(" · ")}
                {report.scope.added.length > 40 ? ` · and ${report.scope.added.length - 40} more` : ""}
              </p>
            </div>
          )}
          {report.scope.deferred.length > 0 && (
            <div>
              <SubHeading>In the total plan, deferred past {labels.name}</SubHeading>
              <p className="text-[12px] leading-relaxed text-slate-700">
                {report.scope.deferred
                  .slice(0, 40)
                  .map((c) => `TC:${c.testCaseId} ${c.name}`)
                  .join(" · ")}
                {report.scope.deferred.length > 40 ? ` · and ${report.scope.deferred.length - 40} more` : ""}
              </p>
            </div>
          )}
        </div>
      )}
      <div>
        <SubHeading>Test sets in this plan</SubHeading>
        <Table head={["Test set", "Module", "Platform", "Folder", "Planned cases"]}>
          {report.testSets.map((r) => (
            <tr key={r.set.testSetId}>
              <td className={td}>{r.set.name}</td>
              <td className={td}>{r.module}</td>
              <td className={td}>{r.stream}</td>
              <td className={td}>{r.folder}</td>
              <td className={num}>{r.spiraTotal}</td>
            </tr>
          ))}
        </Table>
      </div>
    </>
  );
}

export function ReportDocument({ report, changes, siteUrl }: { report: Report; changes: ReportChanges | null; siteUrl: string | null }) {
  const pages =
    report.kind === "planned"
      ? [<SummaryPage key="summary" report={report} />, <PlannedScopePage key="scope" report={report} />]
      : [
          <SummaryPage key="summary" report={report} />,
          <ReadinessPage key="readiness" report={report} />,
          <ModulesPage key="modules" report={report} changes={changes} />,
          <DefectsPage key="defects" report={report} siteUrl={siteUrl} />,
          ...(report.appendix ? [<AppendixPage key="appendix" report={report} siteUrl={siteUrl} />] : []),
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
