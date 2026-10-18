"use client";

import { Bug, ChevronDown, ClipboardList, Play, RefreshCw, Upload, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { logActivity } from "@/lib/client/activity";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import type { PassProgressOutcome, ProgressPick } from "@/lib/client/progress";
import { listUatDrafts, materializeUatCatalog } from "@/lib/client/uat-build";
import { loadWeekCatalog, recordWeekPicks, weekCatalogAsDrafts, type WeekCatalog } from "@/lib/client/week";
import { executionCards, executionCounts } from "@/lib/domain/execution";
import type { Draft } from "@/lib/domain/types";
import { DefectWorkspace } from "../defects/defect-workspace";
import { ImportPanel } from "../progress/import-panel";
import { StatusChip } from "../drafts/[id]/execute/runner";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Tab = "cases" | "defects" | "smoke";

/**
 * UAT build: load Spira cases for the Settings release, run Pass/Fail like Completed,
 * search defects against this build, and optionally import a smoke pack.
 */
export function UatBuildWorkspace({ initialTab }: { initialTab?: Tab }) {
  const { settings, ai, spira } = useSettings();
  const aiOn = !!ai?.configured;
  const [tester, setTester] = useState(() => getTester());
  const [catalog, setCatalog] = useState<WeekCatalog | null>(null);
  const [uatDrafts, setUatDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? "cases");
  const [smokeOpen, setSmokeOpen] = useState(false);

  const projectId = settings?.projectId ?? null;
  const releaseId = settings?.releaseId ?? null;
  const releaseLabel = settings?.releaseLabel?.trim() || (releaseId !== null ? `RL:${releaseId}` : "");

  const importDrafts = useMemo(() => (catalog ? weekCatalogAsDrafts(catalog) : []), [catalog]);

  useEffect(() => {
    if (releaseId === null) return;
    const existing = listUatDrafts(releaseId);
    if (existing.length > 0) setUatDrafts(existing);
  }, [releaseId]);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const load = useCallback(async () => {
    if (projectId === null || releaseId === null) {
      setLoadError("Choose the Testing cycle (UAT or SIT) in Settings and save first.");
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const next = await loadWeekCatalog(projectId, releaseId, releaseLabel);
      setCatalog(next);
      const drafts = materializeUatCatalog(next);
      setUatDrafts(drafts);
      logActivity({
        type: "week.loaded",
        message: `UAT build: loaded ${next.caseCount} Spira cases in ${next.modules.length} modules for ${next.releaseLabel}.`,
        details: { releaseId: next.releaseId, modules: next.modules.length, cases: next.caseCount, source: "uat-build" },
      });
      toast.success(`Loaded ${plural(next.caseCount, "case")} from Spira`);
      setTab("cases");
    } catch (err) {
      setCatalog(null);
      setUatDrafts([]);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, releaseId, releaseLabel]);

  const changeTester = (name: string) => {
    setTester(name);
    storeTester(name);
  };

  const recordPicks = async (
    picks: ProgressPick[],
    name: string,
    options: { force?: boolean; onProgress?: (done: number, total: number) => void; keepGoing?: () => boolean },
  ): Promise<PassProgressOutcome> => {
    if (!catalog) throw new Error("Load Spira cases for this build first.");
    const out = await recordWeekPicks(catalog, picks, name, options);
    if (out.recorded > 0) {
      logActivity({
        type: "progress.recorded",
        message: `Recorded ${out.recorded} UAT build run(s) on ${catalog.releaseLabel}${name ? ` (${name})` : ""}.`,
        details: { recorded: out.recorded, failed: out.failed.length, releaseId: catalog.releaseId, tester: name, source: "uat-build" },
      });
      if (releaseId !== null) setUatDrafts(listUatDrafts(releaseId));
    }
    return {
      results: out.results,
      recorded: out.recorded,
      failed: out.failed.map((f) => ({
        target: picks.find((p) => p.target.card.testCaseId === f.testCaseId)?.target ?? picks[0].target,
        message: f.message,
      })),
    };
  };

  const hasCases = uatDrafts.length > 0;

  if (!spira?.configured) {
    return (
      <Notice tone="warning" title="Spira is not connected" action={<ButtonLink href="/settings" size="sm">Settings</ButtonLink>}>
        Connect Spira in Settings, then open UAT build again.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="UAT build"
        description="Load this release’s iOS/Android cases from Spira, Pass or Fail them like Completed, and fail cases from a defect description — all written to Spira."
        actions={releaseLabel && <Badge tone="brand">{releaseLabel}</Badge>}
      />

      {projectId === null || releaseId === null ? (
        <EmptyState
          icon={ClipboardList}
          title="Choose the build first"
          action={
            <ButtonLink href="/settings" variant="primary">
              Open Settings
            </ButtonLink>
          }
        >
          Set Testing cycle to <strong>UAT</strong> (or SIT), save, then come back here.
        </EmptyState>
      ) : (
        <>
          <Section
            icon={ClipboardList}
            title="Spira cases for this build"
            description="Same release plan as Reports “this build”. Load once, then run modules or search defects."
            actions={
              <Button icon={RefreshCw} variant="primary" busy={loading} onClick={() => void load()}>
                {hasCases ? "Reload from Spira" : "Load cases from Spira"}
              </Button>
            }
          >
            {loadError && (
              <Notice tone="danger" title="Could not load cases">
                {loadError}
              </Notice>
            )}
            {loading && (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Spinner /> Reading planned iOS/Android cases from Spira…
              </p>
            )}
            {hasCases && !loading && (
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                {catalog?.source === "release" ? "Release plan · " : catalog?.folderName ? `Folder ${catalog.folderName} · ` : null}
                {plural(
                  uatDrafts.reduce((n, d) => n + d.testSets.reduce((m, s) => m + s.cards.length, 0), 0),
                  "case",
                )}{" "}
                in {plural(uatDrafts.length, "module")}
                {catalog ? ` · ${plural(catalog.testSetCount, "test set")}` : ""}
              </p>
            )}
            {!hasCases && !loading && !loadError && (
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                Click <strong>Load cases from Spira</strong> to open modules for Pass/Fail and defect search.
              </p>
            )}
          </Section>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <label className="flex min-w-[16rem] max-w-sm flex-col gap-1 text-sm">
              <span className="flex items-center gap-1.5 font-medium">
                <UserRound className="size-4 text-slate-400" aria-hidden /> Tester
              </span>
              <input
                className="input"
                placeholder="e.g. Adejumoke Ariyibi"
                value={tester}
                maxLength={100}
                onChange={(e) => changeTester(e.target.value)}
              />
              <span className="text-xs text-slate-500">Written on every Spira run from this page.</span>
            </label>
          </div>

          {hasCases && (
            <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2 dark:border-white/10">
              {(
                [
                  { id: "cases" as const, label: "Cases", icon: Play },
                  { id: "defects" as const, label: "Defects", icon: Bug },
                  { id: "smoke" as const, label: "Smoke import", icon: Upload },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    tab === t.id
                      ? "bg-brand-600 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10"
                  }`}
                >
                  <t.icon className="size-3.5" aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {tab === "cases" && hasCases && (
            <Section title="Modules" description="Open a module to Pass, Fail, Block or Caution cases — same runner as Completed.">
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {uatDrafts
                  .slice()
                  .sort((a, b) => a.module.localeCompare(b.module))
                  .map((d) => {
                    const cards = executionCards(d);
                    const counts = executionCounts(cards, d.execution);
                    const executed = counts.total - counts.notRun;
                    return (
                      <li
                        key={d.id}
                        className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-zinc-900/40"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-slate-900 dark:text-zinc-100">{d.module}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {plural(counts.total, "case")} · {executed} executed
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5 text-[11px]">
                          {counts.passed > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <StatusChip status="passed" /> {counts.passed}
                            </span>
                          )}
                          {counts.failed > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <StatusChip status="failed" /> {counts.failed}
                            </span>
                          )}
                          {counts.blocked > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <StatusChip status="blocked" /> {counts.blocked}
                            </span>
                          )}
                          {counts.notRun > 0 && <Badge tone="neutral">{counts.notRun} to run</Badge>}
                        </div>
                        <ButtonLink href={`/uat-build/${d.id}/execute`} size="sm" variant="primary" icon={Play}>
                          {executed ? "Continue" : "Run cases"}
                        </ButtonLink>
                      </li>
                    );
                  })}
              </ul>
            </Section>
          )}

          {tab === "defects" && (
            <Section
              icon={Bug}
              title="Defects on this build"
              description="Paste a defect description. Gemini finds cases on this UAT build; Fail them in Spira and optionally log an incident."
            >
              <DefectWorkspace from={null} scopedDrafts={uatDrafts} embedded />
            </Section>
          )}

          {tab === "smoke" && (
            <Section
              icon={Upload}
              title="Smoke import"
              description="Optional: map a UAT smoke pack (.xlsx / .csv) onto this build’s cases, then Record."
              actions={
                <Button size="sm" variant="ghost" icon={ChevronDown} onClick={() => setSmokeOpen((o) => !o)}>
                  {smokeOpen ? "Hide help" : "Show help"}
                </Button>
              }
            >
              {smokeOpen && (
                <p className="mb-3 text-xs text-slate-500">
                  Uses Module, Feature / Journey, Smoke Test Case, and iOS / Android status. Each row pre-ticks at most one Spira case.
                </p>
              )}
              {catalog ? (
                <ImportPanel
                  drafts={importDrafts}
                  tester={tester.trim()}
                  aiOn={aiOn}
                  onChanged={() => {
                    if (releaseId !== null) setUatDrafts(listUatDrafts(releaseId));
                  }}
                  onTesterDetected={(name) => {
                    changeTester(name);
                    toast.success(`Tester set to ${name} for Spira runs`);
                  }}
                  recordPicks={recordPicks}
                />
              ) : (
                <Notice tone="info" title="Load Spira cases first">
                  Smoke import needs the release catalog.{" "}
                  <button type="button" className="font-medium underline" onClick={() => void load()}>
                    Load cases from Spira
                  </button>
                </Notice>
              )}
            </Section>
          )}

          {!hasCases && !loading && (
            <Notice tone="info" title="Load Spira cases to continue">
              After load you can run cases, search defects, or import a smoke pack.{" "}
              <Link href="/settings" className="font-medium underline">
                Settings → Testing cycle
              </Link>{" "}
              should be UAT.
            </Notice>
          )}
        </>
      )}
    </div>
  );
}
