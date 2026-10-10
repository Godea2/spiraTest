"use client";

import clsx from "clsx";
import { useMemo, useRef, useState, type DragEvent } from "react";
import type { WorkBook } from "xlsx";
import { modulesFrom, useSettings } from "@/components/settings-context";
import { Badge, Button, ButtonLink, Field, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { Draft, WorkbookRow } from "@/lib/domain/types";

type SetStatus = "pending" | "running" | "ok" | "failed";

interface LoadedWorkbook {
  fileName: string;
  workbook: WorkBook;
  sheetNames: string[];
}

const workbookLib = () => import("@/lib/domain/workbook");
type WorkbookLib = Awaited<ReturnType<typeof workbookLib>>;

function StepTitle({ n, children, done }: { n: number; children: React.ReactNode; done?: boolean }) {
  return (
    <span className="flex items-center gap-3">
      <span
        className={clsx(
          "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
          done ? "bg-emerald-600 text-white" : "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900",
        )}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      {children}
    </span>
  );
}

export function CompareWorkspace() {
  const { settings, error: settingsError } = useSettings();
  const inputRef = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<LoadedWorkbook | null>(null);
  const [inScopeSheet, setInScopeSheet] = useState("");
  const [needsSheet, setNeedsSheet] = useState("");
  const [rows, setRows] = useState<WorkbookRow[] | null>(null);
  const [workbookModules, setWorkbookModules] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [lib, setLib] = useState<WorkbookLib | null>(null);
  const [module, setModule] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [draftName, setDraftName] = useState("");

  const [draft, setDraft] = useState<Draft | null>(null);
  const [statuses, setStatuses] = useState<Record<number, SetStatus>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const modules = useMemo(() => modulesFrom(settings), [settings]);
  const mappings = useMemo(
    () => (settings ? settings.mappings.filter((m) => m.module === module) : []),
    [settings, module],
  );
  const alias = settings?.moduleAliases[module] ?? "";
  const locked = draft !== null;
  const matchedRows = useMemo(
    () => (lib && rows && module ? lib.filterRowsByModule(rows, module, alias) : []),
    [lib, rows, module, alias],
  );

  function parse(wl: WorkbookLib, source: LoadedWorkbook, inScope: string, needs: string) {
    try {
      const parsed = wl.parseWorkbookRows(source.workbook, inScope, needs || null);
      if (!parsed.hasModuleColumn) throw new wl.WorkbookError("The selected sheets have no “Module” column.");
      setRows(parsed.rows);
      setWorkbookModules(wl.moduleNames(parsed.rows));
      setFileError(null);
    } catch (err) {
      setRows(null);
      setFileError(errorMessage(err));
    }
  }

  async function loadFile(file: File) {
    setReading(true);
    setFileError(null);
    try {
      if (!/\.(xlsx|xlsm|xls)$/i.test(file.name)) throw new Error("Choose an Excel workbook (.xlsx, .xlsm or .xls).");
      const wl = await workbookLib();
      const workbook = wl.readWorkbook(await file.arrayBuffer());
      const source = { fileName: file.name, workbook, sheetNames: workbook.SheetNames };
      const inScope = wl.pickDefaultSheet(source.sheetNames, wl.DEFAULT_IN_SCOPE_SHEET) ?? source.sheetNames[0] ?? "";
      const needs = wl.pickDefaultSheet(source.sheetNames, wl.DEFAULT_NEEDS_CONFIRMATION_SHEET) ?? "";
      setLib(wl);
      setLoaded(source);
      setInScopeSheet(inScope);
      setNeedsSheet(needs);
      parse(wl, source, inScope, needs);
    } catch (err) {
      setLoaded(null);
      setRows(null);
      setFileError(errorMessage(err));
    } finally {
      setReading(false);
    }
  }

  function chooseModule(name: string) {
    setModule(name);
    const ids = settings?.mappings.filter((m) => m.module === name).map((m) => m.testSetId) ?? [];
    setSelected(new Set(ids));
    setDraftName(name ? `${name} · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "");
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file && !locked) void loadFile(file);
  }

  async function compareSet(draftId: string, testSetId: number) {
    setStatuses((s) => ({ ...s, [testSetId]: "running" }));
    setErrors((e) => {
      const next = { ...e };
      delete next[testSetId];
      return next;
    });
    try {
      const { draft: updated } = await api<{ draft: Draft }>(`/api/drafts/${draftId}/compare`, {
        method: "POST",
        body: { testSetId },
      });
      setDraft(updated);
      setStatuses((s) => ({ ...s, [testSetId]: "ok" }));
    } catch (err) {
      setStatuses((s) => ({ ...s, [testSetId]: "failed" }));
      setErrors((e) => ({ ...e, [testSetId]: errorMessage(err) }));
    }
  }

  async function startComparison() {
    if (!loaded || !rows) return;
    setStarting(true);
    setStartError(null);
    const ids = mappings.filter((m) => selected.has(m.testSetId)).map((m) => m.testSetId);
    try {
      const { draft: created } = await api<{ draft: Draft }>("/api/drafts", {
        method: "POST",
        body: {
          name: draftName.trim() || module,
          module,
          source: { fileName: loaded.fileName, inScopeSheet, needsConfirmationSheet: needsSheet || null },
          rows: matchedRows,
          testSetIds: ids,
        },
      });
      setDraft(created);
      setStatuses(Object.fromEntries(ids.map((id) => [id, "pending" as SetStatus])));
      for (const id of ids) await compareSet(created.id, id);
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  function startOver() {
    setDraft(null);
    setStatuses({});
    setErrors({});
    setStartError(null);
  }

  const ids = Object.keys(statuses).map(Number);
  const allOk = ids.length > 0 && ids.every((id) => statuses[id] === "ok");
  const anyRunning = ids.some((id) => statuses[id] === "running" || statuses[id] === "pending");
  const canCompare = !!rows && !!module && selected.size > 0 && matchedRows.length > 0 && !locked;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Compare workbook with Spira"
        description="Upload the release scope workbook, pick a module, and compare it with that module’s test sets. Nothing in Spira changes until you review and apply."
      />

      {settingsError && <Notice tone="danger" title="Settings could not be loaded">{settingsError}</Notice>}
      {settings?.mockMode && (
        <Notice tone="warning" title="Mock mode is on">
          Comparisons use simulated Spira data. Turn it off in Settings to use n8n.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title={<StepTitle n={1} done={!!rows}>Workbook</StepTitle>}>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              if (!locked) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={clsx(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors",
              dragging
                ? "border-brand-500 bg-brand-50 dark:bg-brand-950/30"
                : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600",
              locked && "pointer-events-none opacity-60",
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xlsm,.xls"
              className="sr-only"
              disabled={locked}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = "";
              }}
            />
            {reading ? (
              <span className="flex items-center gap-2 text-sm"><Spinner /> Reading workbook…</span>
            ) : loaded ? (
              <>
                <span className="text-sm font-medium">{loaded.fileName}</span>
                <span className="mt-1 text-xs text-zinc-500">Drop another file or click to replace</span>
              </>
            ) : (
              <>
                <span className="text-sm font-medium">Drop the scope workbook here</span>
                <span className="mt-1 text-xs text-zinc-500">or click to browse · .xlsx</span>
              </>
            )}
          </label>

          {fileError && <Notice tone="danger" className="mt-4">{fileError}</Notice>}

          {loaded && (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="In-Scope sheet">
                {(props) => (
                  <select
                    {...props}
                    className="input"
                    value={inScopeSheet}
                    disabled={locked}
                    onChange={(e) => {
                      setInScopeSheet(e.target.value);
                      if (lib) parse(lib, loaded, e.target.value, needsSheet);
                    }}
                  >
                    {loaded.sheetNames.map((name) => <option key={name}>{name}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Needs Confirmation sheet" hint="Optional. Rows here start in Needs Review.">
                {(props) => (
                  <select
                    {...props}
                    className="input"
                    value={needsSheet}
                    disabled={locked}
                    onChange={(e) => {
                      setNeedsSheet(e.target.value);
                      if (lib) parse(lib, loaded, inScopeSheet, e.target.value);
                    }}
                  >
                    <option value="">None</option>
                    {loaded.sheetNames.filter((n) => n !== inScopeSheet).map((name) => <option key={name}>{name}</option>)}
                  </select>
                )}
              </Field>
            </div>
          )}
          {rows && (
            <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
              {rows.length} rows read across {workbookModules.length} module{workbookModules.length === 1 ? "" : "s"}.
            </p>
          )}
        </Section>

        <Section title={<StepTitle n={2} done={!!module && selected.size > 0 && matchedRows.length > 0}>Module and test sets</StepTitle>}>
          <div className="flex flex-col gap-5">
            <Field label="Module">
              {(props) => (
                <select {...props} className="input" value={module} disabled={locked || !settings} onChange={(e) => chooseModule(e.target.value)}>
                  <option value="">Choose a module…</option>
                  {modules.map((m) => <option key={m}>{m}</option>)}
                </select>
              )}
            </Field>

            {module && rows && (
              matchedRows.length > 0 ? (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  <span className="font-semibold text-zinc-900 dark:text-zinc-100">{matchedRows.length}</span> workbook rows match {module}
                  {alias ? <> (or “{alias}”)</> : null}.
                </p>
              ) : (
                <Notice tone="warning" title={`No workbook rows match ${module}`}>
                  Modules in this workbook: {workbookModules.join(", ") || "none"}. If the workbook uses a different name, add an Excel alias in Settings.
                </Notice>
              )
            )}

            {module && (
              <fieldset>
                <legend className="text-sm font-medium">Test sets</legend>
                <div className="mt-2 divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
                  {mappings.map((m) => (
                    <label key={m.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand-600"
                        checked={selected.has(m.testSetId)}
                        disabled={locked}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(m.testSetId);
                          else next.delete(m.testSetId);
                          setSelected(next);
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate">{m.testSetName || `Test set ${m.testSetId}`}</span>
                      <Badge>{m.platform}</Badge>
                      <span className="font-mono text-xs text-zinc-500">TX{m.testSetId}</span>
                    </label>
                  ))}
                  {mappings.length === 0 && <p className="px-3 py-2.5 text-sm text-zinc-500">No test sets mapped. Add them in Settings.</p>}
                </div>
              </fieldset>
            )}
          </div>
        </Section>
      </div>

      <Section title={<StepTitle n={3} done={allOk}>Compare</StepTitle>}>
        {!draft ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <Field label="Draft name" className="flex-1">
              {(props) => (
                <input {...props} className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="e.g. Onboarding · Sprint 3" maxLength={160} />
              )}
            </Field>
            <Button variant="primary" onClick={startComparison} disabled={!canCompare} busy={starting}>
              Compare {selected.size || ""} test set{selected.size === 1 ? "" : "s"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {ids.map((id) => {
                const mapping = mappings.find((m) => m.testSetId === id);
                const set = draft.testSets.find((s) => s.testSetId === id);
                const status = statuses[id];
                return (
                  <li key={id} className="flex flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center">
                    <div className="w-full min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{mapping?.testSetName ?? `Test set ${id}`}</p>
                      {status === "failed" && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{errors[id]}</p>}
                      {status === "ok" && set && (
                        <p className="mt-0.5 text-xs text-zinc-500">
                          {set.cards.length} cards · {set.missingFromSpira.length} missing from Spira
                        </p>
                      )}
                    </div>
                    {status === "running" && <span className="flex items-center gap-2 text-xs text-zinc-500"><Spinner className="size-3.5" /> Comparing…</span>}
                    {status === "pending" && <span className="text-xs text-zinc-500">Waiting</span>}
                    {status === "ok" && <Badge tone="success">Compared</Badge>}
                    {status === "failed" && (
                      <Button size="sm" onClick={() => compareSet(draft.id, id)} disabled={anyRunning}>
                        Retry
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-3">
              {allOk ? (
                <ButtonLink href={`/drafts/${draft.id}`} variant="primary">Open board</ButtonLink>
              ) : (
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {anyRunning ? "Comparing…" : "Every test set must compare successfully before the board opens."}
                </p>
              )}
              <Button variant="ghost" onClick={startOver} disabled={anyRunning}>Start a new comparison</Button>
            </div>
          </div>
        )}
        {startError && <Notice tone="danger" className="mt-4">{startError}</Notice>}
      </Section>
    </div>
  );
}
