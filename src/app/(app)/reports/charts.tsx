import type { ReactNode } from "react";
import { OUTCOME_LABEL, OUTCOMES, type Outcome, type OutcomeCounts, type TrendDay } from "@/lib/domain/report";

export const OUTCOME_COLOR: Record<Outcome, string> = {
  passed: "#16a34a",
  failed: "#dc2626",
  blocked: "#ea580c",
  caution: "#eab308",
  notRun: "#cbd5e1",
  notApplicable: "#94a3b8",
};

export function Donut({ segments, center, size = 120 }: { segments: Array<{ value: number; color: string }>; center: ReactNode; size?: number }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = 15.915;
  const arcs = segments
    .filter((s) => s.value > 0 && total > 0)
    .map((s, i, shown) => {
      const before = shown.slice(0, i).reduce((n, o) => n + o.value, 0);
      return { color: s.color, length: (s.value / total) * 100, offset: 25 - (before / total) * 100 };
    });
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 42 42" className="size-full" aria-hidden>
        <circle cx="21" cy="21" r={r} fill="none" stroke="#e2e8f0" strokeWidth="5" />
        {arcs.map((a, i) => (
          <circle key={i} cx="21" cy="21" r={r} fill="none" stroke={a.color} strokeWidth="5" strokeDasharray={`${a.length} ${100 - a.length}`} strokeDashoffset={a.offset} />
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-tight">{center}</div>
    </div>
  );
}

/** One row of results as a horizontal bar, each outcome in proportion. */
export function OutcomeBar({ counts, height = 12, show = OUTCOMES }: { counts: OutcomeCounts; height?: number; show?: readonly Outcome[] }) {
  const total = show.reduce((n, o) => n + counts[o], 0);
  return (
    <div className="flex w-full overflow-hidden rounded-sm bg-slate-100" style={{ height }} role="img" aria-label={show.map((o) => `${OUTCOME_LABEL[o]} ${counts[o]}`).join(", ")}>
      {total > 0 &&
        show
          .filter((o) => counts[o] > 0)
          .map((o) => <div key={o} style={{ width: `${(counts[o] / total) * 100}%`, background: OUTCOME_COLOR[o] }} title={`${OUTCOME_LABEL[o]}: ${counts[o]}`} />)}
    </div>
  );
}

export function OutcomeLegend({ show = OUTCOMES, counts }: { show?: readonly Outcome[]; counts?: OutcomeCounts }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
      {show.map((o) => (
        <span key={o} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: OUTCOME_COLOR[o] }} />
          {OUTCOME_LABEL[o]}
          {counts && <span className="font-semibold text-slate-800 tabular-nums">{counts[o].toLocaleString()}</span>}
        </span>
      ))}
    </div>
  );
}

/** Progress towards a target: the bar is the actual, the dark tick the target. */
export function TargetBar({ progress, mark, met }: { progress: number; mark: number | null; met: boolean }) {
  return (
    <div className="relative h-3 w-full rounded-sm bg-slate-100">
      <div className="h-full rounded-sm" style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%`, background: met ? "#16a34a" : "#d97706" }} />
      {mark !== null && <div className="absolute -top-1 -bottom-1 w-0.5 bg-slate-900" style={{ left: `calc(${Math.min(1, mark) * 100}% - 1px)` }} />}
    </div>
  );
}

/** Cases by the day they were last run, with the running total as a line. */
export function TrendChart({ days, total }: { days: TrendDay[]; total: number }) {
  const width = 640;
  const height = 150;
  const pad = { top: 10, right: 34, bottom: 22, left: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxDay = Math.max(1, ...days.map((d) => d.executed));
  const maxCum = Math.max(1, total, ...days.map((d) => d.cumulative));
  const step = plotW / days.length;
  const barW = Math.max(2, step * 0.6);
  const x = (i: number) => pad.left + i * step + (step - barW) / 2;
  const y = (v: number, max: number) => pad.top + plotH - (v / max) * plotH;
  const line = days.map((d, i) => `${x(i) + barW / 2},${y(d.cumulative, maxCum)}`).join(" ");
  const label = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Cases run per day and executed so far">
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke="#cbd5e1" />
      <text x={pad.left - 4} y={pad.top + 8} textAnchor="end" fontSize="9" fill="#64748b">
        {maxDay}
      </text>
      <text x={width - pad.right + 4} y={pad.top + 8} fontSize="9" fill="#4f46e5">
        {maxCum}
      </text>
      {days.map((d, i) => {
        const passH = ((d.executed - d.failed) / maxDay) * plotH;
        const failH = (d.failed / maxDay) * plotH;
        return (
          <g key={d.day}>
            {d.executed > 0 && <rect x={x(i)} y={pad.top + plotH - passH - failH} width={barW} height={passH} fill="#16a34a" rx="1" />}
            {d.failed > 0 && <rect x={x(i)} y={pad.top + plotH - failH} width={barW} height={failH} fill="#dc2626" rx="1" />}
            {(i % 3 === 0 || i === days.length - 1) && (
              <text x={x(i) + barW / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="#64748b">
                {label(d.day)}
              </text>
            )}
          </g>
        );
      })}
      <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth="1.5" />
    </svg>
  );
}
