"use client";

import { useMemo, useState } from "react";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, Dialog, Field, Notice, PageHeader, Section, Spinner, Switch } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { PLATFORMS, type EndpointKind, type Platform, type PublicSettings } from "@/lib/domain/types";

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
  mockMode: boolean;
  mappings: MappingDraft[];
  moduleAliases: Record<string, string>;
  endpoints: Record<EndpointKind, { url: string; clear: boolean }>;
}

const ENV_NAME: Record<EndpointKind, string> = { reconcile: "RECONCILE_WEBHOOK_URL", apply: "APPLY_WEBHOOK_URL" };
const ENDPOINT_COPY: Record<EndpointKind, { title: string; hint: string }> = {
  reconcile: { title: "Reconcile webhook", hint: "Called to compare workbook rows with a test set." },
  apply: { title: "Apply webhook", hint: "Called to remove cases from a test set (dry run or live)." },
};

function toForm(s: PublicSettings): FormState {
  return {
    projectId: String(s.projectId),
    releaseId: String(s.releaseId),
    releaseLabel: s.releaseLabel,
    mockMode: s.mockMode,
    mappings: s.mappings.map((m) => ({ ...m, testSetId: String(m.testSetId) })),
    moduleAliases: { ...s.moduleAliases },
    endpoints: { reconcile: { url: "", clear: false }, apply: { url: "", clear: false } },
  };
}

const newId = () => `m-${Math.random().toString(36).slice(2, 10)}`;
const positiveInt = (v: string) => /^\d+$/.test(v.trim()) && Number(v) > 0;

export function SettingsForm() {
  const { settings, error } = useSettings();
  if (error && !settings) return <Notice tone="danger" title="Settings could not be loaded">{error}</Notice>;
  if (!settings) return <div className="flex items-center gap-2 text-sm text-zinc-500"><Spinner /> Loading settings…</div>;
  return <SettingsEditor settings={settings} />;
}

function SettingsEditor({ settings }: { settings: PublicSettings }) {
  const { replace } = useSettings();
  const [form, setForm] = useState<FormState>(() => toForm(settings));
  const [initial, setInitial] = useState<string>(() => JSON.stringify(toForm(settings)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [newModule, setNewModule] = useState<string | null>(null);
  const [removeModule, setRemoveModule] = useState<string | null>(null);
  const [resettingMock, setResettingMock] = useState(false);

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
      const endpoint = (kind: EndpointKind) =>
        form!.endpoints[kind].clear ? { clear: true } : form!.endpoints[kind].url.trim() ? { url: form!.endpoints[kind].url.trim() } : undefined;
      const saved = await api<PublicSettings>("/api/settings", {
        method: "PUT",
        body: {
          projectId: Number(form!.projectId),
          releaseId: Number(form!.releaseId),
          releaseLabel: form!.releaseLabel.trim(),
          mockMode: form!.mockMode,
          mappings: form!.mappings.map((m) => ({
            id: m.id,
            module: m.module.trim(),
            testSetId: Number(m.testSetId),
            testSetName: m.testSetName.trim(),
            platform: m.platform,
          })),
          moduleAliases: Object.fromEntries(
            Object.entries(form!.moduleAliases).map(([k, v]) => [k.trim(), v.trim()]).filter(([, v]) => v),
          ),
          endpoints: { reconcile: endpoint("reconcile"), apply: endpoint("apply") },
        },
      });
      replace(saved);
      const f = toForm(saved);
      setForm(f);
      setInitial(JSON.stringify(f));
      setErrors({});
      setMessage({ tone: "success", text: "Settings saved." });
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function resetMock() {
    setResettingMock(true);
    try {
      await api("/api/mock/reset", { method: "POST" });
      setMessage({ tone: "success", text: "Mock Spira data was reset to the original fixture." });
    } catch (err) {
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setResettingMock(false);
    }
  }

  const liveWithoutEndpoints =
    !form.mockMode &&
    (["reconcile", "apply"] as const).some(
      (k) => (settings.endpoints[k].source === "none" || form.endpoints[k].clear) && !form.endpoints[k].url.trim(),
    );

  return (
    <div className="flex flex-col gap-6 pb-24">
      <PageHeader
        title="Settings"
        description="Where comparisons point, how modules map to Spira test sets, and which n8n workflows run them."
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

      <Section title="Data source">
        <Switch
          checked={form.mockMode}
          onChange={(mockMode) => update({ mockMode })}
          label="Mock mode"
          description="Use simulated Spira data instead of n8n. Recommended for training and testing; live apply only changes the simulation."
        />
        {liveWithoutEndpoints && (
          <Notice tone="warning" className="mt-4">With Mock mode off, both webhooks need a URL. Add one below or set the environment variables.</Notice>
        )}
        {settings.mockMode && (
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Restore simulated test sets after a mock live apply.</p>
            <Button size="sm" onClick={resetMock} busy={resettingMock}>Reset mock data</Button>
          </div>
        )}
      </Section>

      <Section
        title="Automation endpoints"
        description="The server calls these n8n webhooks. The browser never contacts n8n or Spira directly, and saved URLs are never sent back to the browser."
      >
        <div className="mb-5 flex items-center gap-2 text-sm">
          {settings.webhookSecretConfigured ? (
            <><Badge tone="success">Secret configured</Badge><span className="text-zinc-600 dark:text-zinc-400">WEBHOOK_SECRET is sent as the X-Webhook-Secret header.</span></>
          ) : (
            <><Badge tone="danger">Secret missing</Badge><span className="text-zinc-600 dark:text-zinc-400">Set WEBHOOK_SECRET in the server environment. n8n calls are disabled until then.</span></>
          )}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          {(["reconcile", "apply"] as const).map((kind) => {
            const status = settings.endpoints[kind];
            const change = form.endpoints[kind];
            const setChange = (patch: Partial<typeof change>) =>
              update({ endpoints: { ...form.endpoints, [kind]: { ...change, ...patch } } });
            return (
              <div key={kind} className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <div>
                  <h3 className="text-sm font-semibold">{ENDPOINT_COPY[kind].title}</h3>
                  <p className="text-xs text-zinc-500">{ENDPOINT_COPY[kind].hint}</p>
                </div>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {status.source === "override" && <Badge tone="brand">Saved URL</Badge>}
                  {status.source === "environment" && <Badge>Environment</Badge>}
                  {status.source === "none" && <Badge tone="warning">Not configured</Badge>}
                  <span className="text-zinc-600 dark:text-zinc-400">
                    {status.source === "override" && <>Using the URL saved here{status.host && <> · <span className="font-mono">{status.host}</span></>}</>}
                    {status.source === "environment" && <>Using {ENV_NAME[kind]}{status.host && <> · <span className="font-mono">{status.host}</span></>}</>}
                    {status.source === "none" && <>No saved URL and no {ENV_NAME[kind]}</>}
                  </span>
                </p>
                {change.clear ? (
                  <Notice tone="warning" action={<Button size="sm" onClick={() => setChange({ clear: false })}>Keep it</Button>}>
                    The saved URL will be removed on save. {kind === "reconcile" ? "Reconcile" : "Apply"} will fall back to {ENV_NAME[kind]}, if it is set.
                  </Notice>
                ) : (
                  <Field label="Replace URL" hint="Leave blank to keep the current endpoint." error={errors[`endpoints.${kind}`]}>
                    {(p) => (
                      <input
                        {...p}
                        className="input font-mono"
                        type="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://n8n.example.com/webhook/…"
                        value={change.url}
                        onChange={(e) => setChange({ url: e.target.value })}
                      />
                    )}
                  </Field>
                )}
                {status.source === "override" && !change.clear && (
                  <Button size="sm" variant="ghost" className="self-start" onClick={() => setChange({ clear: true, url: "" })}>
                    Clear saved override
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Section>

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
