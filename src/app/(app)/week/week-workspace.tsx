"use client";

import { CalendarDays, RefreshCw, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, EmptyState, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import { logActivity } from "@/lib/client/activity";
import type { PassProgressOutcome, ProgressPick } from "@/lib/client/progress";
import { loadWeekCatalog, recordWeekPicks, weekCatalogAsDrafts, type WeekCatalog } from "@/lib/client/week";
import { ImportPanel } from "../progress/import-panel";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Map this week's Excel (issue log or smoke pack) straight onto Spira for the Settings build.
 * No Compare workbook — cases are read from the UAT (or SIT) release test sets.
 */
export function WeekWorkspace() {
  const { settings, ai, spira } = useSettings();
  const aiOn = !!ai?.configured;
  const [tester, setTester] = useState(() => getTester());
  const [catalog, setCatalog] = useState<WeekCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const projectId = settings?.projectId ?? null;
  const releaseId = settings?.releaseId ?? null;
  const releaseLabel = settings?.releaseLabel?.trim() || (releaseId !== null ? `RL:${releaseId}` : "");

  const drafts = useMemo(() => (catalog ? weekCatalogAsDrafts(catalog) : []), [catalog]);

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
      logActivity({
        type: "week.loaded",
        message: `Loaded ${next.caseCount} Spira cases in ${next.modules.length} modules for ${next.releaseLabel}.`,
        details: { releaseId: next.releaseId, modules: next.modules.length, cases: next.caseCount },
      });
      toast.success(`Loaded ${plural(next.caseCount, "case")} from Spira`);
    } catch (err) {
      setCatalog(null);
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
        message: `Recorded ${out.recorded} week run(s) on ${catalog.releaseLabel}${name ? ` (${name})` : ""}.`,
        details: { recorded: out.recorded, failed: out.failed.length, releaseId: catalog.releaseId, tester: name },
      });
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

  if (!spira?.configured) {
    return (
      <Notice tone="warning" title="Spira is not connected" action={<ButtonLink href="/settings" size="sm">Settings</ButtonLink>}>
        Connect Spira in Settings, then open Week again.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Week"
        description="Upload the UAT smoke pack: Module, Feature / Journey, Smoke Test Case, and iOS / Android status. Cases load from the same release plan as Reports (this build). Gemini matches each row; you review, then Record."
        actions={releaseLabel && <Badge tone="brand">{releaseLabel}</Badge>}
      />

      {projectId === null || releaseId === null ? (
        <EmptyState
          icon={CalendarDays}
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
            icon={CalendarDays}
            title="Spira cases for this build"
            description="Loads iOS/Android test sets planned on this release — same basis as Reports “this build” (~631 runs for UAT). API sets are left out."
            actions={
              <Button icon={RefreshCw} variant="primary" busy={loading} onClick={() => void load()}>
                {catalog ? "Reload from Spira" : "Load cases from Spira"}
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
            {catalog && !loading && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-slate-600 dark:text-zinc-400">
                  {catalog.source === "release" ? (
                    <>Release plan · </>
                  ) : catalog.folderName ? (
                    <>
                      Folder <span className="font-medium">{catalog.folderName}</span>
                      {" · "}
                    </>
                  ) : null}
                  {plural(catalog.caseCount, "case")} in {plural(catalog.modules.length, "module")} · {plural(catalog.testSetCount, "test set")}
                  {catalog.source === "release" ? " (aligned with Reports this build)" : ""}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {catalog.modules.map((m) => (
                    <li key={m.module}>
                      <Badge>
                        {m.module} · {m.caseCount}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!catalog && !loading && !loadError && (
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                Click <strong>Load cases from Spira</strong> once. Then upload the smoke pack — Gemini maps Module / Feature / Smoke Test Case to Spira; iOS and Android statuses become separate results. Nothing is written until you Record.
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
              <span className="text-xs text-slate-500">Written on every Spira run. Filled from the sheet when a Tester column exists.</span>
            </label>
          </div>

          {catalog ? (
            <ImportPanel
              drafts={drafts}
              tester={tester.trim()}
              aiOn={aiOn}
              onChanged={() => {}}
              onTesterDetected={(name) => {
                changeTester(name);
                toast.success(`Tester set to ${name} for Spira runs`);
              }}
              recordPicks={recordPicks}
            />
          ) : (
            <Notice tone="info" title="Load Spira cases before uploading">
              Week maps your smoke pack to the planned iOS/Android cases on this release (same plan Reports uses).{" "}
              <Link href="/settings" className="font-medium underline">
                Settings → Testing cycle
              </Link>{" "}
              should be UAT, then Load cases above.
            </Notice>
          )}
        </>
      )}
    </div>
  );
}
