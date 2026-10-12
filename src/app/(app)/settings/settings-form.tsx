"use client";

import { Boxes, CloudDownload, Database, FolderKanban, PlugZap, Plus, RefreshCw, ScanText } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, Dialog, Field, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { logActivity } from "@/lib/client/activity";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { saveSettings } from "@/lib/client/settings-store";
import { INITIAL_SYNC, storeSync } from "@/lib/client/store-sync";
import { guessMapping, SettingsValidationError, type SettingsUpdate } from "@/lib/domain/settings";
import {
  PLATFORMS,
  type AppSettings,
  type Platform,
  type SpiraProject,
  type SpiraRelease,
  type SpiraTestSetSummary,
} from "@/lib/domain/types";

interface MappingDraft {
  id: string;
  module: string;
  testSetId: string;
  testSetName: string;
  platform: Platform;
}

interface FormState {
  projectId: string;
  releaseId: string;
  releaseLabel: string;
  planReleaseId: string;
  mappings: MappingDraft[];
  moduleAliases: Record<string, string>;
}

function toForm(s: AppSettings): FormState {
  return {
    projectId: s.projectId === null ? "" : String(s.projectId),
    releaseId: s.releaseId === null ? "" : String(s.releaseId),
    releaseLabel: s.releaseLabel,
    planReleaseId: s.planReleaseId === null ? "" : String(s.planReleaseId),
    mappings: s.mappings.map((m) => ({ ...m, testSetId: String(m.testSetId) })),
    moduleAliases: { ...s.moduleAliases },
  };
}

const newId = () => `m-${Math.random().toString(36).slice(2, 10)}`;
const positiveInt = (v: string) => /^\d+$/.test(v.trim()) && Number(v) > 0;
const optionalId = (v: string) => (v.trim() ? Number(v) : null);

export function SettingsForm() {
  const { settings } = useSettings();
  if (!settings) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading settings…</div>;
  return <SettingsEditor settings={settings} />;
}

type Connection =
  | { status: "idle" | "loading" }
  | { status: "ok"; userName: string; projects: SpiraProject[] }
  | { status: "error"; error: string };

/** Signs in to Spira (through the server) once it is configured, and again on request. */
function useSpiraConnection(configured: boolean) {
  const [result, setResult] = useState<{ attempt: number; connection: Connection } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    api<{ userName: string; projects: SpiraProject[] }>("/api/spira", { method: "POST", body: {} })
      .then((c) => {
        if (cancelled) return;
        setResult({ attempt, connection: { status: "ok", ...c } });
        if (attempt > 0) logActivity({ type: "spira.checked", message: `Spira connection checked as ${c.userName}.` });
      })
      .catch((err) => {
        if (!cancelled) setResult({ attempt, connection: { status: "error", error: errorMessage(err) } });
      });
    return () => {
      cancelled = true;
    };
  }, [configured, attempt]);

  const connection: Connection = !configured
    ? { status: "idle" }
    : result && result.attempt === attempt
      ? result.connection
      : { status: "loading" };
  return { connection, retest: () => setAttempt((a) => a + 1) };
}

type Releases = { status: "idle" | "loading" } | { status: "ok"; releases: SpiraRelease[] } | { status: "error"; error: string };

/** Loads the project's releases and sprints whenever a valid project is chosen. */
function useReleases(configured: boolean, projectId: number | null) {
  const [result, setResult] = useState<{ projectId: number; releases: Releases } | null>(null);

  useEffect(() => {
    if (!configured || projectId === null) return;
    let cancelled = false;
    api<{ releases: SpiraRelease[] }>("/api/spira/releases", { method: "POST", body: { projectId } })
      .then(({ releases }) => {
        if (!cancelled) setResult({ projectId, releases: { status: "ok", releases } });
      })
      .catch((err) => {
        if (!cancelled) setResult({ projectId, releases: { status: "error", error: errorMessage(err) } });
      });
    return () => {
      cancelled = true;
    };
  }, [configured, projectId]);

  if (!configured || projectId === null) return { status: "idle" } as Releases;
  return result && result.projectId === projectId ? result.releases : ({ status: "loading" } as Releases);
}

function SettingsEditor({ settings }: { settings: AppSettings }) {
  const { replace, spira } = useSettings();
  const { connection, retest } = useSpiraConnection(spira?.configured === true);
  const projects = connection.status === "ok" ? connection.projects : [];
  const [releaseLookup, setReleaseLookup] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() => toForm(settings));
  const [initial, setInitial] = useState<string>(() => JSON.stringify(toForm(settings)));
  const releases = useReleases(spira?.configured === true, positiveInt(form.projectId) ? Number(form.projectId) : null);
  const releaseList = releases.status === "ok" && releases.releases.length > 0 ? releases.releases : null;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [newModule, setNewModule] = useState<string | null>(null);
  const [removeModule, setRemoveModule] = useState<string | null>(null);

  const modules = useMemo(() => {
    const order: string[] = [];
    for (const m of form.mappings) if (!order.includes(m.module)) order.push(m.module);
    return order;
  }, [form]);

  const dirty = JSON.stringify(form) !== initial;
  const update = (patch: Partial<FormState>) => {
    setForm({ ...form, ...patch });
    setMessage(null);
  };
  const updateMapping = (id: string, patch: Partial<MappingDraft>) =>
    update({ mappings: form.mappings.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  const indexOf = (id: string) => form.mappings.findIndex((m) => m.id === id);

  function renameModule(from: string, to: string) {
    const aliases = { ...form!.moduleAliases };
    if (aliases[from] !== undefined) {
      aliases[to] = aliases[from];
      delete aliases[from];
    }
    update({ mappings: form!.mappings.map((m) => (m.module === from ? { ...m, module: to } : m)), moduleAliases: aliases });
  }

  async function lookUpRelease() {
    setReleaseLookup({ busy: true, error: null });
    try {
      const release = await api<SpiraRelease>("/api/spira/release", {
        method: "POST",
        body: { projectId: Number(form.projectId), releaseId: Number(form.releaseId) },
      });
      update({ releaseLabel: release.label });
      setReleaseLookup({ busy: false, error: null });
    } catch (err) {
      setReleaseLookup({ busy: false, error: errorMessage(err) });
    }
  }

  function addTestSets(picked: Array<{ testSet: SpiraTestSetSummary; module: string; platform: Platform }>) {
    update({
      mappings: [
        ...form.mappings,
        ...picked.map(({ testSet, module, platform }) => ({
          id: newId(),
          module: module.trim(),
          testSetId: String(testSet.testSetId),
          testSetName: testSet.name,
          platform,
        })),
      ],
    });
    setPickerOpen(false);
  }

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (form!.projectId.trim() && !positiveInt(form!.projectId)) e.projectId = "Enter a positive whole number.";
    if (form!.releaseId.trim() && !positiveInt(form!.releaseId)) e.releaseId = "Enter a positive whole number.";
    if (form!.planReleaseId.trim() && !positiveInt(form!.planReleaseId)) e.planReleaseId = "Enter a positive whole number.";
    const seen = new Map<string, number>();
    form!.mappings.forEach((m, i) => {
      if (!m.module.trim()) e[`mappings.${i}.module`] = "Module name is required.";
      if (!positiveInt(m.testSetId)) e[`mappings.${i}.testSetId`] = "Enter the numeric test set ID.";
      else if (seen.has(m.testSetId.trim())) e[`mappings.${i}.testSetId`] = `Test set ${m.testSetId} is mapped more than once.`;
      seen.set(m.testSetId.trim(), i);
    });
    return e;
  }

  async function save() {
    const clientErrors = validate();
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) {
      setMessage({ tone: "danger", text: "Fix the highlighted fields and save again." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const update: SettingsUpdate = {
        projectId: optionalId(form.projectId),
        releaseId: optionalId(form.releaseId),
        releaseLabel: form.releaseLabel.trim(),
        planReleaseId: optionalId(form.planReleaseId),
        mappings: form.mappings.map((m) => ({
          id: m.id,
          module: m.module.trim(),
          testSetId: Number(m.testSetId),
          testSetName: m.testSetName.trim(),
          platform: m.platform,
        })),
        moduleAliases: Object.fromEntries(
          Object.entries(form.moduleAliases).map(([k, v]) => [k.trim(), v.trim()]).filter(([, v]) => v),
        ),
      };
      const saved = saveSettings(update);
      replace(saved);
      logActivity({
        type: "settings.updated",
        message: "Settings saved.",
        details: { projectId: saved.projectId, releaseId: saved.releaseId, planReleaseId: saved.planReleaseId, mappings: saved.mappings.length },
      });
      const f = toForm(saved);
      setForm(f);
      setInitial(JSON.stringify(f));
      setErrors({});
      setMessage({ tone: "success", text: "Settings saved." });
    } catch (err) {
      if (err instanceof SettingsValidationError) setErrors(err.fieldErrors);
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 pb-24">
      <PageHeader
        title="Settings"
        description="Which Spira project and releases to use, and how modules map to Spira test sets."
        actions={settings.updatedAt && <span className="text-xs text-zinc-500">Last saved {formatDateTime(settings.updatedAt)}</span>}
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <SpiraConnection connection={connection} onRetest={retest} />
        <AiReviewStatus />
      </div>
      <SharedStorage />

      <Section
        icon={FolderKanban}
        title="Spira project"
        description="Set to Project-Simba with Phase 1 in 1.0.0.0002 and the total test plan in 1.0.0.0001 unless changed here. Used for every new comparison and report; existing drafts keep the values they were created with."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Project"
            error={errors.projectId}
            hint={connection.status === "ok" ? "Projects your Spira user can open." : "Enter the project ID, or connect to Spira to pick from a list."}
          >
            {(p) =>
              connection.status === "ok" ? (
                <select {...p} className="input" value={form.projectId} onChange={(e) => update({ projectId: e.target.value })}>
                  <option value="">Choose a project…</option>
                  {form.projectId && !projects.some((x) => String(x.projectId) === form.projectId) && (
                    <option value={form.projectId}>Project {form.projectId} (not available to this user)</option>
                  )}
                  {projects.map((x) => (
                    <option key={x.projectId} value={x.projectId}>{x.name} (PR:{x.projectId})</option>
                  ))}
                </select>
              ) : (
                <input {...p} className="input" inputMode="numeric" value={form.projectId} onChange={(e) => update({ projectId: e.target.value })} />
              )
            }
          </Field>
          <Field
            label="Phase 1 release"
            error={errors.releaseId ?? releaseLookup.error}
            hint={
              releaseList
                ? "The release being tested now. Compare uses it, and the report shows it as Phase 1."
                : releases.status === "loading"
                  ? "Reading releases from Spira…"
                  : releases.status === "error"
                    ? `Could not list releases (${releases.error}). Enter the release ID instead.`
                    : "The release or sprint ID from Spira (RL:…)."
            }
          >
            {(p) =>
              releaseList ? (
                <select
                  {...p}
                  className="input"
                  value={form.releaseId}
                  onChange={(e) => {
                    const chosen = releaseList.find((r) => String(r.releaseId) === e.target.value);
                    update({ releaseId: e.target.value, releaseLabel: chosen?.label ?? "" });
                  }}
                >
                  <option value="">Choose the release being tested…</option>
                  {form.releaseId && !releaseList.some((r) => String(r.releaseId) === form.releaseId) && (
                    <option value={form.releaseId}>Release {form.releaseId} (not in this project)</option>
                  )}
                  {releaseList.map((r) => (
                    <option key={r.releaseId} value={r.releaseId}>
                      {"\u00a0\u00a0".repeat(r.depth)}
                      {r.label} (RL:{r.releaseId}){r.active ? "" : " · inactive"}
                    </option>
                  ))}
                </select>
              ) : (
              <div className="flex gap-2">
                <input
                  {...p}
                  className="input min-w-0 flex-1"
                  inputMode="numeric"
                  value={form.releaseId}
                  onChange={(e) => {
                    setReleaseLookup({ busy: false, error: null });
                    update({ releaseId: e.target.value });
                  }}
                />
                <Button
                  onClick={lookUpRelease}
                  busy={releaseLookup.busy}
                  disabled={!spira?.configured || !positiveInt(form.projectId) || !positiveInt(form.releaseId)}
                  title="Read the release name from Spira"
                >
                  Look up
                </Button>
              </div>
              )
            }
          </Field>
          <Field
            label="Total test plan release"
            error={errors.planReleaseId}
            hint={releaseList ? "The release holding every test case in the plan. The report measures Phase 1 against it." : "The release or sprint ID from Spira (RL:…). Empty uses the release before Phase 1."}
          >
            {(p) =>
              releaseList ? (
                <select {...p} className="input" value={form.planReleaseId} onChange={(e) => update({ planReleaseId: e.target.value })}>
                  <option value="">The release before Phase 1</option>
                  {form.planReleaseId && !releaseList.some((r) => String(r.releaseId) === form.planReleaseId) && (
                    <option value={form.planReleaseId}>Release {form.planReleaseId} (not in this project)</option>
                  )}
                  {releaseList.map((r) => (
                    <option key={r.releaseId} value={r.releaseId} disabled={String(r.releaseId) === form.releaseId}>
                      {"\u00a0\u00a0".repeat(r.depth)}
                      {r.label} (RL:{r.releaseId}){r.active ? "" : " · inactive"}
                    </option>
                  ))}
                </select>
              ) : (
                <input {...p} className="input" inputMode="numeric" value={form.planReleaseId} onChange={(e) => update({ planReleaseId: e.target.value })} />
              )
            }
          </Field>
          <Field label="Release label" hint="Shown on boards and exports. Filled from Spira when you choose the Phase 1 release.">
            {(p) => <input {...p} className="input" value={form.releaseLabel} maxLength={200} onChange={(e) => update({ releaseLabel: e.target.value })} />}
          </Field>
        </div>
      </Section>

      <Section
        icon={Boxes}
        title="Modules and test sets"
        description="Optional. Compare already finds a module's test sets in Spira by name (for example Onboarding-Android and Onboarding-IOS for Onboarding). Map them here only to pin a different set, or set an Excel alias if the workbook spells a module differently."
        actions={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={CloudDownload}
              onClick={() => setPickerOpen(true)}
              disabled={!spira?.configured || !positiveInt(form.projectId)}
              title={!positiveInt(form.projectId) ? "Choose a project first." : undefined}
            >
              Load test sets from Spira
            </Button>
            <Button size="sm" icon={Plus} onClick={() => setNewModule("")}>Add module</Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5">
          {modules.map((module) => {
            const rows = form.mappings.filter((m) => m.module === module);
            return (
              <div key={rows[0].id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                <div className="grid gap-3 border-b border-zinc-100 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:border-zinc-800">
                  <Field label="Module" error={errors[`mappings.${indexOf(rows[0].id)}.module`]}>
                    {(p) => <input {...p} className="input font-medium" value={module} onChange={(e) => renameModule(module, e.target.value)} />}
                  </Field>
                  <Field label="Excel alias" hint="Optional">
                    {(p) => (
                      <input
                        {...p}
                        className="input"
                        placeholder="Same as module"
                        value={form.moduleAliases[module] ?? ""}
                        onChange={(e) => update({ moduleAliases: { ...form.moduleAliases, [module]: e.target.value } })}
                      />
                    )}
                  </Field>
                  <Button size="sm" variant="ghostDanger" onClick={() => setRemoveModule(module)}>Remove module</Button>
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {rows.map((m) => {
                    const i = indexOf(m.id);
                    return (
                      <div key={m.id} className="grid gap-3 p-4 sm:grid-cols-[8rem_1fr_9rem_auto] sm:items-start">
                        <Field label="Test set ID" error={errors[`mappings.${i}.testSetId`]}>
                          {(p) => <input {...p} className="input font-mono" inputMode="numeric" value={m.testSetId} onChange={(e) => updateMapping(m.id, { testSetId: e.target.value })} />}
                        </Field>
                        <Field label="Name">
                          {(p) => <input {...p} className="input" value={m.testSetName} onChange={(e) => updateMapping(m.id, { testSetName: e.target.value })} />}
                        </Field>
                        <Field label="Platform">
                          {(p) => (
                            <select {...p} className="input" value={m.platform} onChange={(e) => updateMapping(m.id, { platform: e.target.value as Platform })}>
                              {PLATFORMS.map((pl) => <option key={pl}>{pl}</option>)}
                            </select>
                          )}
                        </Field>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="sm:mt-7"
                          aria-label={`Remove test set ${m.testSetId}`}
                          disabled={rows.length === 1}
                          title={rows.length === 1 ? "A module needs at least one test set. Remove the module instead." : undefined}
                          onClick={() => update({ mappings: form.mappings.filter((x) => x.id !== m.id) })}
                        >
                          Remove
                        </Button>
                      </div>
                    );
                  })}
                </div>
                <div className="p-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => update({ mappings: [...form.mappings, { id: newId(), module, testSetId: "", testSetName: "", platform: "Android" }] })}
                  >
                    + Add test set
                  </Button>
                </div>
              </div>
            );
          })}
          {modules.length === 0 && (
            <p className="text-sm text-zinc-500">No modules mapped. That is fine: Compare reads each module&rsquo;s test sets from Spira.</p>
          )}
        </div>
      </Section>

      {(dirty || message) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <p className={message?.tone === "danger" ? "text-sm text-red-600 dark:text-red-400" : message ? "text-sm text-emerald-700 dark:text-emerald-400" : "text-sm text-zinc-600 dark:text-zinc-400"} role="status">
              {message?.text ?? "You have unsaved changes."}
            </p>
            <div className="ml-auto flex gap-2">
              {dirty && (
                <Button onClick={() => { const f = JSON.parse(initial) as FormState; setForm(f); setErrors({}); setMessage(null); }} disabled={saving}>
                  Discard
                </Button>
              )}
              {dirty ? (
                <Button variant="primary" onClick={save} busy={saving}>Save changes</Button>
              ) : (
                <Button variant="ghost" onClick={() => setMessage(null)}>Dismiss</Button>
              )}
            </div>
          </div>
        </div>
      )}

      <Dialog
        open={newModule !== null}
        onClose={() => setNewModule(null)}
        title="Add module"
        footer={
          <>
            <Button onClick={() => setNewModule(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!newModule?.trim() || modules.includes(newModule.trim())}
              onClick={() => {
                update({ mappings: [...form.mappings, { id: newId(), module: newModule!.trim(), testSetId: "", testSetName: "", platform: "Android" }] });
                setNewModule(null);
              }}
            >
              Add
            </Button>
          </>
        }
      >
        <Field label="Module name" hint="Match the Module column in the workbook, or set an alias afterwards." error={newModule && modules.includes(newModule.trim()) ? "That module already exists." : null}>
          {(p) => <input {...p} className="input" autoFocus value={newModule ?? ""} onChange={(e) => setNewModule(e.target.value)} />}
        </Field>
      </Dialog>

      <Dialog
        open={removeModule !== null}
        onClose={() => setRemoveModule(null)}
        title={`Remove ${removeModule}?`}
        footer={
          <>
            <Button onClick={() => setRemoveModule(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const aliases = { ...form.moduleAliases };
                delete aliases[removeModule!];
                update({ mappings: form.mappings.filter((m) => m.module !== removeModule), moduleAliases: aliases });
                setRemoveModule(null);
              }}
            >
              Remove module
            </Button>
          </>
        }
      >
        Its test set mappings and Excel alias are removed when you save. Existing drafts are not affected.
      </Dialog>

      {pickerOpen && (
        <TestSetPicker
          projectId={Number(form.projectId)}
          releaseId={positiveInt(form.releaseId) ? Number(form.releaseId) : null}
          mapped={new Map(form.mappings.map((m) => [m.testSetId.trim(), m.module]))}
          onClose={() => setPickerOpen(false)}
          onAdd={addTestSets}
        />
      )}
    </div>
  );
}

interface PickRow {
  module: string;
  platform: Platform;
  checked: boolean;
}

/** Lists test sets straight from Spira; nothing is added until the form is saved. */
function TestSetPicker({
  projectId,
  releaseId,
  mapped,
  onClose,
  onAdd,
}: {
  projectId: number;
  releaseId: number | null;
  mapped: Map<string, string>;
  onClose: () => void;
  onAdd: (picked: Array<{ testSet: SpiraTestSetSummary; module: string; platform: Platform }>) => void;
}) {
  const [releaseOnly, setReleaseOnly] = useState(releaseId !== null);
  const filter = releaseOnly ? releaseId : null;
  const [loaded, setLoaded] = useState<{ filter: number | null; testSets: SpiraTestSetSummary[] | null; error: string | null } | null>(null);
  const [picks, setPicks] = useState<Record<number, PickRow>>({});
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    api<{ testSets: SpiraTestSetSummary[] }>("/api/spira/test-sets", { method: "POST", body: { projectId, releaseId: filter } })
      .then(({ testSets }) => {
        if (!cancelled) setLoaded({ filter, testSets, error: null });
      })
      .catch((err) => {
        if (!cancelled) setLoaded({ filter, testSets: null, error: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filter]);

  const current = loaded && loaded.filter === filter ? loaded : null;
  const rowFor = (t: SpiraTestSetSummary): PickRow => picks[t.testSetId] ?? { ...guessMapping(t.name), checked: false };
  const setRow = (t: SpiraTestSetSummary, patch: Partial<PickRow>) =>
    setPicks((p) => ({ ...p, [t.testSetId]: { ...rowFor(t), ...patch } }));

  const term = search.trim().toLowerCase();
  const visible = (current?.testSets ?? []).filter(
    (t) => !term || t.name.toLowerCase().includes(term) || String(t.testSetId).includes(term),
  );
  const chosen = (current?.testSets ?? [])
    .filter((t) => !mapped.has(String(t.testSetId)) && rowFor(t).checked)
    .map((t) => ({ testSet: t, module: rowFor(t).module, platform: rowFor(t).platform }));
  const missingModule = chosen.some((c) => !c.module.trim());

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`Test sets in project ${projectId}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={chosen.length === 0 || missingModule} onClick={() => onAdd(chosen)}>
            Add {chosen.length || ""} test set{chosen.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>Tick the test sets to compare. Module and platform are suggested from the Spira name; change them if needed. Nothing is saved until you click Save changes.</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="search"
            className="input sm:max-w-xs"
            placeholder="Filter by name or ID"
            aria-label="Filter test sets"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {releaseId !== null && (
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-brand-600" checked={releaseOnly} onChange={(e) => setReleaseOnly(e.target.checked)} />
              Only test sets planned for release {releaseId}
            </label>
          )}
        </div>

        {!current ? (
          <div className="flex items-center gap-2 text-zinc-500"><Spinner /> Reading test sets from Spira…</div>
        ) : current.error ? (
          <Notice tone="danger" title="Could not load test sets">{current.error}</Notice>
        ) : current.testSets!.length === 0 ? (
          <Notice tone="info">
            {releaseOnly ? "No test sets are planned for this release in Spira. Untick the release filter to see all test sets." : "This project has no test sets."}
          </Notice>
        ) : (
          <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-zinc-50 text-xs text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="w-10 px-3 py-2"><span className="sr-only">Add</span></th>
                  <th className="px-3 py-2 font-medium">Test set</th>
                  <th className="px-3 py-2 font-medium">Release</th>
                  <th className="px-3 py-2 font-medium">Module</th>
                  <th className="px-3 py-2 font-medium">Platform</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {visible.map((t) => {
                  const mappedTo = mapped.get(String(t.testSetId));
                  const row = rowFor(t);
                  return (
                    <tr key={t.testSetId} className={mappedTo ? "opacity-60" : undefined}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-4 accent-brand-600"
                          aria-label={`Add ${t.name}`}
                          disabled={!!mappedTo}
                          checked={!!mappedTo || row.checked}
                          onChange={(e) => setRow(t, { checked: e.target.checked })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{t.name}</span>
                        <span className="ml-2 font-mono text-xs text-zinc-500">TX{t.testSetId}</span>
                        {mappedTo && <span className="block text-xs text-zinc-500">Already mapped to {mappedTo}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500">{t.releaseVersion ?? "—"}</td>
                      <td className="px-3 py-2">
                        <input
                          className="input py-1"
                          aria-label={`Module for ${t.name}`}
                          disabled={!!mappedTo}
                          value={mappedTo ?? row.module}
                          onChange={(e) => setRow(t, { module: e.target.value, checked: true })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="input py-1"
                          aria-label={`Platform for ${t.name}`}
                          disabled={!!mappedTo}
                          value={row.platform}
                          onChange={(e) => setRow(t, { platform: e.target.value as Platform, checked: true })}
                        >
                          {PLATFORMS.map((pl) => <option key={pl}>{pl}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {missingModule && <p className="text-xs text-red-600 dark:text-red-400">Every ticked test set needs a module name.</p>}
      </div>
    </Dialog>
  );
}

function SpiraConnection({ connection, onRetest }: { connection: Connection; onRetest: () => void }) {
  const { spira, spiraError } = useSettings();

  return (
    <Section
      icon={PlugZap}
      title="Spira connection"
      description="The server calls Spira with credentials set in its environment. The browser never contacts Spira and never sees the API key."
      actions={
        spira?.configured && (
          <Button size="sm" icon={RefreshCw} onClick={onRetest} busy={connection.status === "loading"}>Test connection</Button>
        )
      }
    >
      {!spira ? (
        spiraError ? (
          <Notice tone="danger" title="Connection status could not be loaded">{spiraError}</Notice>
        ) : (
          <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading…</div>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-zinc-500">Spira site</dt>
              <dd className="mt-0.5 font-mono">{spira.host ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">User</dt>
              <dd className="mt-0.5 font-mono">{spira.username ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">API key</dt>
              <dd className="mt-0.5">
                {spira.apiKeyConfigured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not set</Badge>}
              </dd>
            </div>
          </dl>
          {!spira.configured && (
            <Notice tone="warning" title="Spira is not connected">
              {spira.problems.join(" ")} Set SPIRA_BASE_URL, SPIRA_USERNAME and SPIRA_API_KEY in the server environment, then redeploy.
            </Notice>
          )}
          {connection.status === "ok" && (
            <Notice tone="success">
              Signed in as {connection.userName}. {connection.projects.length} project{connection.projects.length === 1 ? "" : "s"} available.
            </Notice>
          )}
          {connection.status === "error" && <Notice tone="danger" title="Spira sign-in failed">{connection.error}</Notice>}
        </div>
      )}
    </Section>
  );
}

function SharedStorage() {
  const sync = useSyncExternalStore(storeSync.subscribe, storeSync.state, () => INITIAL_SYNC);
  return (
    <Section
      icon={Database}
      title="Shared storage"
      description="Drafts, executions, defects, activity, settings and report setups are saved in Supabase through the server, so every browser and teammate sees the same data. The browser never contacts Supabase and never sees its key."
      actions={
        sync.mode === "cloud" && (
          <Button size="sm" icon={RefreshCw} onClick={() => void storeSync.sync()} busy={sync.busy}>Sync now</Button>
        )
      }
    >
      {sync.mode === "local" ? (
        <Notice tone="info" title="Saved in this browser only">
          Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server environment and run supabase/schema.sql in Supabase, then redeploy. What is saved here is uploaded the first time the app opens after that.
        </Notice>
      ) : sync.error ? (
        <Notice tone="warning" title="Changes are not saved to Supabase yet">
          {sync.error} They are kept in this browser and saved automatically when Supabase answers.
        </Notice>
      ) : sync.mode === "cloud" ? (
        <Notice tone="success">
          Connected to Supabase.{sync.savedAt ? ` Last saved ${formatDateTime(sync.savedAt)}.` : " Everything is saved."}
        </Notice>
      ) : (
        <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Connecting…</div>
      )}
    </Section>
  );
}

function AiReviewStatus() {
  const { ai } = useSettings();
  return (
    <Section
      icon={ScanText}
      title="Gemini review of blocked cases"
      description="When you filter a board by not-implemented keywords, Gemini reads each matching test scenario and says whether the case really depends on the missing feature. Deep check also asks about scenarios that name no keyword. You review every suggestion before anything moves."
    >
      {!ai ? (
        <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">Status</dt>
              <dd className="mt-1">{ai.configured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not set</Badge>}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Model</dt>
              <dd className="mt-0.5 font-mono">{ai.model || "Not set"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Sent to Google</dt>
              <dd className="mt-0.5">Test case names, workbook scenarios and keywords only</dd>
            </div>
          </dl>
          {!ai.configured && (
            <Notice tone="info" title="Using keyword matching only">
              Set GEMINI_API_KEY (and optionally GEMINI_MODEL) in the server environment, then redeploy. Until then, a keyword in the test scenario counts as Blocked.
            </Notice>
          )}
        </div>
      )}
    </Section>
  );
}
