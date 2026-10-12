"use client";

import clsx from "clsx";
import { ArrowRight, CheckCircle2, Clock, Layers, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, Button, Notice, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { allDrafts, createDraft, getDraft } from "@/lib/client/drafts";
import { compareTestSet, completeWithoutChanges } from "@/lib/client/workflow";
import { allCards, countColumns, isCompleted } from "@/lib/domain/board";
import type { AppSettings, SpiraTestSetSummary, WorkbookRow } from "@/lib/domain/types";
import { planWorkbook, type ModulePlan, type ModuleState, type PlannedSet } from "@/lib/domain/workbook-plan";

const STATE: Record<ModuleState, { label: string; tone: "success" | "brand" | "warning" | "neutral" }> = {
  done: { label: "Completed", tone: "success" },
  inProgress: { label: "Draft in review", tone: "brand" },
  partly: { label: "Partly done", tone: "warning" },
  new: { label: "To compare", tone: "neutral" },
  noTestSets: { label: "No test sets", tone: "warning" },
};

type RunState = { status: "waiting" | "running" | "ok" | "failed"; draftId?: string; summary?: string; error?: string };

function SetChip({ set }: { set: PlannedSet }) {
  const { state } = set;
  const tone = state.kind === "completed" ? "success" : state.kind === "inDraft" ? "brand" : "neutral";
  const title =
    state.kind === "completed"
      ? `Completed in "${state.draftName}": ${state.kept} cases kept`
      : state.kind === "inDraft"
        ? `On the draft "${state.draftName}", still in review`
        : `Not compared yet${set.releaseVersion ? ` · release ${set.releaseVersion}` : ""}`;
  return (
    <span title={title}>
      <Badge tone={tone}>
        {set.ref.platform} · TX{set.ref.testSetId}
        {state.kind === "completed" ? ` · ${state.kept} kept` : ""}
      </Badge>
    </span>
  );
}

/**
 * Compares every module of the workbook in one go, skipping test sets already on a draft (completed
 * ones keep their board and executions). Each module gets its own draft to review and apply as usual.
 */
export function WholeWorkbook({
  rowsOf,
  modules,
  settings,
  testSets,
  source,
  locked,
}: {
  rowsOf: (module: string) => WorkbookRow[];
  modules: string[];
  settings: AppSettings;
  testSets: SpiraTestSetSummary[];
  source: { fileName: string; inScopeSheet: string; needsConfirmationSheet: string | null };
  locked: boolean;
}) {
  // Shown only once a workbook is read in the browser, so the drafts can be read here.
  const [drafts, setDrafts] = useState(() => allDrafts());
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [running, setRunning] = useState(false);
  const projectId = settings.projectId!;

  const plan = useMemo(
    () =>
      planWorkbook({
        modules: modules.map((name) => ({ name, rows: rowsOf(name).length })),
        testSets,
        drafts,
        projectId,
        releaseId: settings.releaseId,
        mappings: settings.mappings,
        aliases: settings.moduleAliases,
      }),
    [modules, rowsOf, testSets, drafts, projectId, settings],
  );
  const defaults = useMemo(() => new Set(plan.modules.filter((m) => m.state === "new").map((m) => m.module)), [plan]);
  const selected = picked ?? defaults;
  const chosen = plan.modules.filter((m) => selected.has(m.module) && m.toCompare.length > 0);
  const toCompare = chosen.reduce((n, m) => n + m.toCompare.length, 0);
  const done = plan.modules.filter((m) => m.state === "done");
  const finished = Object.values(runs).filter((r) => r.status === "ok" || r.status === "failed").length;

  const toggle = (module: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(module);
    else next.delete(module);
    setPicked(next);
  };

  async function compareModule(m: ModulePlan, date: string) {
    setRuns((r) => ({ ...r, [m.module]: { status: "running" } }));
    try {
      const draft = createDraft({
        name: `${m.module} · ${date}`,
        module: m.module,
        projectId,
        releaseId: settings.releaseId,
        releaseLabel: settings.releaseLabel,
        source,
        rows: rowsOf(m.module),
        testSetIds: m.toCompare.map((r) => r.testSetId),
        testSetRefs: m.toCompare,
      });
      setRuns((r) => ({ ...r, [m.module]: { status: "running", draftId: draft.id } }));
      const errors: string[] = [];
      for (const ref of m.toCompare) {
        try {
          await compareTestSet(draft.id, ref.testSetId, settings.mappings);
        } catch (err) {
          errors.push(`${ref.testSetName}: ${errorMessage(err)}`);
        }
      }
      if (!errors.length) await completeWithoutChanges(draft.id).catch(() => undefined);
      const latest = getDraft(draft.id);
      const c = countColumns(allCards(latest.testSets), latest.decisions);
      const summary = isCompleted(latest.status)
        ? `Completed: all ${c.inScope + c.defects} cases in scope, nothing to change in Spira`
        : `${c.inScope} In Scope · ${c.outOfScope} Out of Scope · ${c.needsReview} Needs Review`;
      setRuns((r) => ({ ...r, [m.module]: errors.length ? { status: "failed", draftId: draft.id, summary, error: errors.join(" ") } : { status: "ok", draftId: draft.id, summary } }));
    } catch (err) {
      setRuns((r) => ({ ...r, [m.module]: { status: "failed", error: errorMessage(err) } }));
    }
  }

  async function compareAll() {
    setRunning(true);
    setRuns(Object.fromEntries(chosen.map((m) => [m.module, { status: "waiting" } as RunState])));
    const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    for (const m of chosen) await compareModule(m, date);
    setRunning(false);
    setPicked(new Set());
    setDrafts(allDrafts());
  }

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Layers className="size-4" aria-hidden /> Whole workbook
        </span>
      }
      description="Every module in the workbook at once. Test sets already on a draft are skipped, so completed modules keep their boards and executions; each other module gets its own draft to review and apply as usual. Comparing only reads Spira."
    >
      <div className="flex flex-col gap-4">
        {settings.releaseId === null && (
          <Notice tone="warning" title="No release chosen in Settings">
            Choose the release being tested (for example 1.0.0.0002) in Settings, so each module is compared with that release&apos;s test sets.
          </Notice>
        )}
        {plan.outside.length > 0 && (
          <Notice tone="warning" title={`${plan.outside.length} test set${plan.outside.length === 1 ? " is" : "s are"} in ${settings.releaseLabel || "the release"} but not in the workbook`}>
            {plan.outside.map((t) => `${t.name} (TX${t.testSetId})`).join(", ")}. Their cases still count in the report for this release. If they are not in this build, move them to another release in Spira.
          </Notice>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-zinc-400">
                <th className="w-8 py-1.5" />
                <th className="py-1.5 pr-3 font-medium">Module</th>
                <th className="py-1.5 pr-3 text-right font-medium">Rows</th>
                <th className="py-1.5 pr-3 font-medium">Test sets</th>
                <th className="py-1.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {plan.modules.map((m) => {
                const run = runs[m.module];
                const can = m.toCompare.length > 0;
                return (
                  <tr key={m.module} className="border-t border-slate-100 align-top dark:border-white/[0.06]">
                    <td className="py-2.5">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand-600"
                        aria-label={`Compare ${m.module}`}
                        checked={can && selected.has(m.module)}
                        disabled={!can || running || locked}
                        onChange={(e) => toggle(m.module, e.target.checked)}
                      />
                    </td>
                    <td className="py-2.5 pr-3 font-medium">{m.module}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{m.rows.toLocaleString()}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {m.sets.map((s) => (
                          <SetChip key={s.ref.testSetId} set={s} />
                        ))}
                        {m.sets.length === 0 && <span className="text-xs text-slate-500">No test set found for this module; map it in Settings.</span>}
                      </div>
                      {m.state === "partly" && !run && (
                        <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                          One platform is done. Push to the other platform from Completed copies its board and results; tick to compare with the workbook instead.
                        </p>
                      )}
                    </td>
                    <td className="py-2.5">
                      {!run ? (
                        <Badge tone={STATE[m.state].tone}>{STATE[m.state].label}</Badge>
                      ) : run.status === "waiting" ? (
                        <span className="flex items-center gap-1.5 text-xs text-slate-500">
                          <Clock className="size-3.5" aria-hidden /> Waiting
                        </span>
                      ) : run.status === "running" ? (
                        <span className="flex items-center gap-1.5 text-xs text-brand-600 dark:text-brand-300">
                          <Spinner className="size-3.5" /> Comparing {m.toCompare.length} test set{m.toCompare.length === 1 ? "" : "s"}…
                        </span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span className={clsx("flex items-center gap-1.5 text-xs", run.status === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-400")}>
                            {run.status === "ok" ? <CheckCircle2 className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}
                            {run.summary ?? run.error}
                          </span>
                          {run.status === "failed" && run.summary && <span className="text-xs text-red-600 dark:text-red-400">{run.error}</span>}
                          {run.draftId && (
                            <Link href={`/drafts/${run.draftId}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-300">
                              Open board <ArrowRight className="size-3" aria-hidden />
                            </Link>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {running && <ProgressBar value={finished} max={Math.max(1, Object.keys(runs).length)} />}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" icon={Layers} onClick={() => void compareAll()} busy={running} disabled={chosen.length === 0 || locked}>
            Compare {chosen.length} module{chosen.length === 1 ? "" : "s"} ({toCompare} test set{toCompare === 1 ? "" : "s"})
          </Button>
          <span className="text-xs text-slate-500 dark:text-zinc-400">
            {done.length > 0 && `Skipped as completed: ${done.map((m) => m.module).join(", ")}. `}Nothing is written to Spira until you apply each board.
          </span>
        </div>
      </div>
    </Section>
  );
}
