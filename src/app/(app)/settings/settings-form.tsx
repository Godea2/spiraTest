"use client";

import { useMemo, useState } from "react";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, Dialog, Field, Notice, PageHeader, Section, Spinner } from "@/components/ui";
import { logActivity } from "@/lib/client/activity";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { saveSettings } from "@/lib/client/settings-store";
import { SettingsValidationError, type SettingsUpdate } from "@/lib/domain/settings";
import { PLATFORMS, type AppSettings, type Platform } from "@/lib/domain/types";

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
  mappings: MappingDraft[];
  moduleAliases: Record<string, string>;
}

function toForm(s: AppSettings): FormState {
  return {
    projectId: String(s.projectId),
    releaseId: String(s.releaseId),
    releaseLabel: s.releaseLabel,
    mappings: s.mappings.map((m) => ({ ...m, testSetId: String(m.testSetId) })),
    moduleAliases: { ...s.moduleAliases },
  };
}

const newId = () => `m-${Math.random().toString(36).slice(2, 10)}`;
const positiveInt = (v: string) => /^\d+$/.test(v.trim()) && Number(v) > 0;

export function SettingsForm() {
  const { settings } = useSettings();
  if (!settings) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading settings…</div>;
  return <SettingsEditor settings={settings} />;
}

function SettingsEditor({ settings }: { settings: AppSettings }) {
  const { replace } = useSettings();
  const [form, setForm] = useState<FormState>(() => toForm(settings));
  const [initial, setInitial] = useState<string>(() => JSON.stringify(toForm(settings)));
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

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!positiveInt(form!.projectId)) e.projectId = "Enter a positive whole number.";
    if (!positiveInt(form!.releaseId)) e.releaseId = "Enter a positive whole number.";
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
        projectId: Number(form.projectId),
        releaseId: Number(form.releaseId),
        releaseLabel: form.releaseLabel.trim(),
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
        details: { projectId: saved.projectId, releaseId: saved.releaseId, mappings: saved.mappings.length },
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
        description="Which Spira project and release to compare against, and how modules map to Spira test sets. Saved in this browser."
        actions={settings.updatedAt && <span className="text-xs text-zinc-500">Last saved {formatDateTime(settings.updatedAt)}</span>}
      />

      <Section title="Spira project" description="Used for every new comparison. Existing drafts keep the values they were created with.">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Project ID" error={errors.projectId}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={form.projectId} onChange={(e) => update({ projectId: e.target.value })} />}
          </Field>
          <Field label="Release ID" error={errors.releaseId}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={form.releaseId} onChange={(e) => update({ releaseId: e.target.value })} />}
          </Field>
          <Field label="Release label" hint="Shown on boards and exports.">
            {(p) => <input {...p} className="input" value={form.releaseLabel} maxLength={200} onChange={(e) => update({ releaseLabel: e.target.value })} />}
          </Field>
        </div>
      </Section>

      <SpiraConnection projectId={settings.projectId} />

      <Section
        title="Modules and test sets"
        description="Each module compares against its test sets. If the workbook spells a module differently, set an Excel alias; it applies to every test set in that module."
        actions={<Button size="sm" onClick={() => setNewModule("")}>Add module</Button>}
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
          {modules.length === 0 && <p className="text-sm text-zinc-500">No modules yet. Add one to start comparing.</p>}
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
    </div>
  );
}

function SpiraConnection({ projectId }: { projectId: number }) {
  const { spira, spiraError } = useSettings();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const { userName, projectName } = await api<{ userName: string; projectName: string }>("/api/spira", {
        method: "POST",
        body: { projectId },
      });
      setResult({ tone: "success", text: `Signed in as ${userName}. Project ${projectId} is "${projectName}".` });
      logActivity({ type: "spira.checked", message: `Spira connection checked for project ${projectId}.` });
    } catch (err) {
      setResult({ tone: "danger", text: errorMessage(err) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <Section
      title="Spira connection"
      description="The server calls Spira with credentials set in its environment. The browser never contacts Spira and never sees the API key."
      actions={spira?.configured && <Button size="sm" onClick={check} busy={checking}>Test connection</Button>}
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
          {result && <Notice tone={result.tone}>{result.text}</Notice>}
        </div>
      )}
    </Section>
  );
}
