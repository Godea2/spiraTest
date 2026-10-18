"use client";

import { Check, NotebookPen, RefreshCw, Square, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Dialog, EmptyState, Notice, PageHeader, ProgressBar, Section, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { logActivity } from "@/lib/client/activity";
import { getTester, setTester as storeTester } from "@/lib/client/execution";
import {
  mapNotesItems,
  parseNotes,
  picksFromNotes,
  type MappedNotesItem,
  type NotesParseResult,
} from "@/lib/client/notes";
import type { PassProgressOutcome } from "@/lib/client/progress";
import { loadWeekCatalog, recordWeekPicks, weekCatalogAsDrafts, type WeekCatalog } from "@/lib/client/week";
import { isSettledNotesStatus, MAX_NOTES_TEXT } from "@/lib/domain/notes";
import type { BlockedConfidence } from "@/lib/domain/types";
import { StatusChip } from "../drafts/[id]/execute/runner";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const RELEVANCE_TONE: Record<BlockedConfidence, "brand" | "warning" | "neutral"> = {
  high: "brand",
  medium: "warning",
  low: "neutral",
};

const EXAMPLE = `Cards
- User is able to successfully create virtual cards
- Masked PAN digits, only the last 4 of the card pan to be displayed
- Status is card is showing as expected (Inactive or active)

What's left
- Freeze and unfreeze
- Block cards
- View transaction detail log in transaction history

Account
- User is able to see acct tier level and a CTA button to upgrade
- A click on the button takes user to the modal to upgrade tier`;

/**
 * Paste informal tester notes; Gemini splits done vs left, maps Spira cases on the UAT build plan,
 * and records Passed for reviewed done items only.
 */
export function NotesWorkspace() {
  const { settings, ai, spira } = useSettings();
  const aiOn = !!ai?.configured;
  const [tester, setTester] = useState(() => getTester());
  const [catalog, setCatalog] = useState<WeekCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [parsed, setParsed] = useState<NotesParseResult | null>(null);
  const [mapped, setMapped] = useState<MappedNotesItem[] | null>(null);
  const [parsing, setParsing] = useState(false);
  const [mapping, setMapping] = useState<{ done: number; total: number; label: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [job, setJob] = useState<{ done: number; total: number; stopping: boolean } | null>(null);
  const [outcome, setOutcome] = useState<PassProgressOutcome | null>(null);
  const stopRef = useRef(false);

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
        message: `Notes: loaded ${next.caseCount} Spira cases for ${next.releaseLabel}.`,
        details: { releaseId: next.releaseId, modules: next.modules.length, cases: next.caseCount, source: "notes" },
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

  async function runParseAndMap() {
    if (!catalog || !aiOn || drafts.length === 0) return;
    const text = notes.trim();
    if (text.length < 20) {
      toast.error("Paste a few lines of tester notes first.");
      return;
    }
    setParsing(true);
    setParsed(null);
    setMapped(null);
    setOutcome(null);
    try {
      const modules = catalog.modules.map((m) => m.module);
      const next = await parseNotes(text, modules);
      setParsed(next);
      if (next.items.length === 0) {
        toast.error("No done / left bullets were found in those notes.");
        return;
      }
      setMapping({ done: 0, total: next.items.length, label: "" });
      const rows = await mapNotesItems(next.items, drafts, setMapping);
      setMapped(rows);
      toast.success(`Mapped ${plural(next.items.length, "note")} to Spira cases`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setParsing(false);
      setMapping(null);
    }
  }

  const picks = mapped ? picksFromNotes(mapped) : [];
  const doneMapped = mapped?.filter((m) => m.item.bucket === "done") ?? [];
  const leftMapped = mapped?.filter((m) => m.item.bucket === "left") ?? [];

  function toggleCase(itemId: string, caseKey: string) {
    setMapped(
      (list) =>
        list?.map((m) => {
          if (m.item.id !== itemId) return m;
          const match = m.matches.find((c) => `${c.target.draftId}|${c.target.card.key}` === caseKey);
          if (match && isSettledNotesStatus(match.target.card.executionStatus)) return m;
          const selected = new Set(m.selected);
          if (selected.has(caseKey)) selected.delete(caseKey);
          else selected.add(caseKey);
          return { ...m, selected };
        }) ?? null,
    );
  }

  async function apply() {
    if (!catalog) return;
    setConfirming(false);
    stopRef.current = false;
    setJob({ done: 0, total: picks.length, stopping: false });
    try {
      const out = await recordWeekPicks(catalog, picks, tester.trim(), {
        onProgress: (done, total) => setJob((j) => (j ? { ...j, done, total } : j)),
        keepGoing: () => !stopRef.current,
      });
      setOutcome({
        results: out.results,
        recorded: out.recorded,
        failed: out.failed.map((f) => ({
          target: picks.find((p) => p.target.card.testCaseId === f.testCaseId)?.target ?? picks[0].target,
          message: f.message,
        })),
      });
      if (out.recorded > 0) {
        logActivity({
          type: "progress.recorded",
          message: `Notes: recorded ${out.recorded} Passed run(s) on ${catalog.releaseLabel}${tester.trim() ? ` (${tester.trim()})` : ""}.`,
          details: { recorded: out.recorded, failed: out.failed.length, releaseId: catalog.releaseId, tester: tester.trim(), source: "notes" },
        });
        toast.success(`Recorded ${out.recorded} Passed run(s) in Spira`);
      } else {
        toast.error(out.failed[0]?.message ?? "Nothing was recorded in Spira.");
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setJob(null);
    }
  }

  if (!spira?.configured) {
    return (
      <Notice tone="warning" title="Spira is not connected" action={<ButtonLink href="/settings" size="sm">Settings</ButtonLink>}>
        Connect Spira in Settings, then open Notes again.
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Notes"
        description="Paste informal tester updates (done, what’s left, and known bugs). Gemini maps bullets to Spira cases on this build; Record Passed for done items only. Already Passed or Failed cases are left alone."
        actions={releaseLabel && <Badge tone="brand">{releaseLabel}</Badge>}
      />

      {projectId === null || releaseId === null ? (
        <EmptyState
          icon={NotebookPen}
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
            icon={NotebookPen}
            title="Spira cases for this build"
            description="Same release plan as UAT build / Reports this build (iOS/Android). Load once before mapping notes."
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
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                {plural(catalog.caseCount, "case")} in {plural(catalog.modules.length, "module")} · {plural(catalog.testSetCount, "test set")}
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
              <span className="text-xs text-slate-500">Written on every Spira Passed run from Notes.</span>
            </label>
          </div>

          {!catalog ? (
            <Notice tone="info" title="Load Spira cases before pasting notes">
              Notes maps bullets to the planned iOS/Android cases on this release.{" "}
              <Link href="/settings" className="font-medium underline">
                Settings → Testing cycle
              </Link>{" "}
              should be UAT, then Load cases above.
            </Notice>
          ) : (
            <Section
              icon={NotebookPen}
              title="Paste tester notes"
              description="Build pass summaries, “What’s left”, and bug lines (reset password, dummy data, BVN…) all work. Failures stay visibility-only."
            >
              {!aiOn && (
                <Notice tone="warning" title="Gemini is not configured on the server">
                  Parsing and matching need GEMINI_API_KEY.
                </Notice>
              )}
              <textarea
                className="input min-h-[14rem] font-mono text-sm"
                value={notes}
                maxLength={MAX_NOTES_TEXT}
                placeholder={EXAMPLE}
                disabled={!!job || parsing || !!mapping}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  busy={parsing || !!mapping}
                  disabled={!aiOn || notes.trim().length < 20 || !!job}
                  onClick={() => void runParseAndMap()}
                >
                  Understand and map
                </Button>
                <button
                  type="button"
                  className="text-xs text-slate-500 underline"
                  onClick={() => setNotes(EXAMPLE)}
                  disabled={!!job || parsing}
                >
                  Insert example
                </button>
              </div>
              {(parsing || mapping) && (
                <p className="mt-3 flex items-center gap-2 text-sm text-slate-500">
                  <Spinner />
                  {parsing
                    ? "Gemini is splitting done / left bullets…"
                    : mapping
                      ? `Matching ${mapping.done} of ${mapping.total}${mapping.label ? ` · ${mapping.label}` : ""}…`
                      : null}
                </p>
              )}
            </Section>
          )}

          {parsed && mapped && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-slate-600 dark:text-zinc-400">
                <span className="font-medium">{parsed.title}</span>
                {" · "}
                {plural(doneMapped.length, "done")} · {plural(leftMapped.length, "left")}
              </p>

              {doneMapped.length > 0 && (
                <Section
                  title="Done — Record as Passed"
                  description="One case pre-ticked per bullet when Gemini is confident. Already Passed or Failed matches are ignored."
                >
                  <ul className="flex flex-col gap-4">
                    {doneMapped.map((m) => (
                      <NoteCard key={m.item.id} row={m} onToggle={toggleCase} recordable />
                    ))}
                  </ul>
                </Section>
              )}

              {leftMapped.length > 0 && (
                <Section title="What’s left — not written" description="Mapped for visibility only. These are not sent to Spira from Notes.">
                  <ul className="flex flex-col gap-4">
                    {leftMapped.map((m) => (
                      <NoteCard key={m.item.id} row={m} onToggle={toggleCase} recordable={false} />
                    ))}
                  </ul>
                </Section>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-4 dark:bg-white/[0.03]">
                <p className="text-xs text-slate-600 dark:text-zinc-400">
                  {picks.length === 0
                    ? "Tick cases under Done to record Passed."
                    : `${plural(picks.length, "Passed run")} ready${tester.trim() ? `, tested by ${tester.trim()}` : ""}. What’s left is never written.`}
                </p>
                <Button
                  variant="primary"
                  icon={Check}
                  disabled={picks.length === 0 || !tester.trim() || !!job || parsing || !!mapping}
                  onClick={() => setConfirming(true)}
                  title={!tester.trim() ? "Set the Tester name above" : undefined}
                >
                  Record {picks.length || ""} Passed in Spira
                </Button>
              </div>
            </div>
          )}

          {job && (
            <Notice
              tone="info"
              title={`Recording: ${job.done} of ${job.total}${job.stopping ? " (stopping after this batch)" : ""}`}
              action={
                <Button
                  size="sm"
                  icon={Square}
                  disabled={job.stopping}
                  onClick={() => {
                    stopRef.current = true;
                    setJob((j) => (j ? { ...j, stopping: true } : j));
                  }}
                >
                  Stop
                </Button>
              }
            >
              <ProgressBar value={job.done} max={Math.max(1, job.total)} />
            </Notice>
          )}

          {outcome && !job && (
            <Notice
              tone={outcome.failed.length && outcome.recorded === 0 ? "danger" : outcome.failed.length ? "warning" : "success"}
              title={outcome.recorded === 0 ? "No run was recorded" : `${plural(outcome.recorded, "Passed run")} recorded in Spira`}
            >
              {outcome.recorded > 0 && <p>Open Reports and generate again for the latest figures.</p>}
              {outcome.failed.length > 0 && (
                <ul className="mt-2 text-xs">
                  {outcome.failed.slice(0, 6).map((f, i) => (
                    <li key={i}>
                      TC{f.target.card.testCaseId}: {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
        </>
      )}

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Record ${plural(picks.length, "Passed run")} in Spira?`}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="primary" icon={Check} onClick={() => void apply()}>
              Record {picks.length}
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Writes <StatusChip status="passed" /> for the ticked cases under Done
          {tester.trim() ? (
            <>
              , attributed to <span className="font-medium">{tester.trim()}</span>
            </>
          ) : null}
          . What’s left is not written.
        </p>
      </Dialog>
    </div>
  );
}

function NoteCard({
  row,
  onToggle,
  recordable,
}: {
  row: MappedNotesItem;
  onToggle: (itemId: string, caseKey: string) => void;
  recordable: boolean;
}) {
  return (
    <li className="rounded-xl border border-slate-200 px-4 py-3 dark:border-white/10">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-800 dark:text-zinc-100">{row.item.text}</p>
          <p className="mt-1 text-xs text-slate-500">
            {row.item.moduleHint || "Module unclear"}
            {row.item.platform ? ` · ${row.item.platform}` : ""}
          </p>
        </div>
        <Badge tone={row.item.bucket === "done" ? "success" : "neutral"}>{row.item.bucket === "done" ? "Done" : "Left"}</Badge>
      </div>
      {row.error && <p className="mt-2 text-xs text-red-600">{row.error}</p>}
      {row.matches.length === 0 && !row.error && <p className="mt-2 text-xs text-slate-500">No matching Spira cases found.</p>}
      {row.matches.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {row.matches.map((c) => {
            const key = `${c.target.draftId}|${c.target.card.key}`;
            const settled = isSettledNotesStatus(c.target.card.executionStatus);
            const checked = !settled && row.selected.has(key);
            const canTick = recordable && !settled;
            return (
              <li key={key}>
                <label className={`flex items-start gap-2 text-sm ${canTick ? "cursor-pointer" : "opacity-70"}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-brand-600"
                    checked={checked}
                    disabled={!canTick}
                    onChange={() => onToggle(row.item.id, key)}
                  />
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-slate-500">TC{c.target.card.testCaseId}</span> {c.target.card.name}
                    <span className="ml-2 inline-flex flex-wrap gap-1">
                      <Badge tone={RELEVANCE_TONE[c.candidate.relevance]}>{c.candidate.relevance}</Badge>
                      <Badge>{clip(c.target.testSetName, 28)}</Badge>
                      {settled ? (
                        <Badge tone="neutral">Already {c.target.card.executionStatus} · ignored</Badge>
                      ) : (
                        <Badge tone="neutral">{c.target.card.executionStatus || "Not Run"}</Badge>
                      )}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
