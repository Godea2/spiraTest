"use client";

import { ArrowLeft, Bookmark, CheckCircle2, ExternalLink, FolderPlus, LockOpen, RefreshCw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, EmptyState, Notice, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { addBucket, listBuckets, removeBucket, updateBucket } from "@/lib/client/defect-buckets";
import { forLaterIds, setForLater } from "@/lib/client/defect-local-review";
import { formatDateTime } from "@/lib/client/format";
import {
  listProjectIncidents,
  readIncidentDescription,
  updateIncidentStatus,
  writeIncidentDescription,
} from "@/lib/client/incident-register";
import { readIncidentOptions } from "@/lib/client/defects";
import {
  filterIncidents,
  FOR_LATER_SELECT,
  incidentsInBucket,
  MAX_BUCKET_NAME,
  pickStatusForOpen,
  sortIncidents,
  type DefectBucket,
  type IncidentOpenFilter,
  type IncidentSort,
} from "@/lib/domain/incident-register";
import type { IncidentStatusOption, ReportIncident } from "@/lib/domain/types";

const FILTERS: { id: IncidentOpenFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
  { id: "forLater", label: "For later" },
];

const SORTS: { id: IncidentSort; label: string }[] = [
  { id: "id", label: "Newest id" },
  { id: "created", label: "Newest created" },
  { id: "name", label: "Name" },
];

function SpiraIncidentLink({
  href,
  incidentId,
  className,
}: {
  href: string | null;
  incidentId: number;
  className?: string;
}) {
  const label = `IN:${incidentId}`;
  if (!href) return <span className={className}>{label}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center gap-1 font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300 ${className ?? ""}`}
      title={`Open ${label} in Spira`}
    >
      {label}
      <ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

export function DefectRegister() {
  const { settings, spira } = useSettings();
  const projectId = settings?.projectId ?? null;
  const configured = spira?.configured === true;
  const siteUrl = spira?.siteUrl ?? null;
  const incidentUrl = (incidentId: number) => (siteUrl && projectId !== null ? `${siteUrl}/${projectId}/Incident/${incidentId}.aspx` : null);

  const [incidents, setIncidents] = useState<ReportIncident[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [statuses, setStatuses] = useState<IncidentStatusOption[]>([]);
  const [buckets, setBuckets] = useState<DefectBucket[]>([]);
  const [later, setLater] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<IncidentOpenFilter>("open");
  const [sort, setSort] = useState<IncidentSort>("id");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bucketName, setBucketName] = useState("");
  const [activeBucketId, setActiveBucketId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [descDrafts, setDescDrafts] = useState<Record<number, string>>({});
  const [descSaved, setDescSaved] = useState<Record<number, string>>({});
  const [descLoadingIds, setDescLoadingIds] = useState<Set<number>>(new Set());
  const descStarted = useRef<Set<number>>(new Set());

  const reloadBuckets = useCallback(() => {
    if (projectId === null) return;
    setBuckets(listBuckets(projectId));
  }, [projectId]);

  const reloadLater = useCallback(() => {
    if (projectId === null) return;
    setLater(forLaterIds(projectId));
  }, [projectId]);

  const load = useCallback(async () => {
    if (projectId === null || !configured) return;
    setLoading(true);
    setError(null);
    try {
      const [list, options] = await Promise.all([listProjectIncidents(projectId), readIncidentOptions(projectId)]);
      setIncidents(list.incidents);
      setComplete(list.complete);
      setStatuses(options.statuses);
      setBuckets(listBuckets(projectId));
      setLater(forLaterIds(projectId));
    } catch (err) {
      setError(errorMessage(err));
      setIncidents(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, configured]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!incidents) return [];
    return sortIncidents(filterIncidents(incidents, filter, query, later), sort);
  }, [incidents, filter, query, sort, later]);

  const markForLater = (incidentId: number, on: boolean) => {
    if (projectId === null) return;
    setForLater(projectId, incidentId, on);
    reloadLater();
    toast.success(on ? `IN:${incidentId} marked For later (app only).` : `IN:${incidentId} removed from For later.`);
  };

  const openStatus = useMemo(() => pickStatusForOpen(statuses, true), [statuses]);
  const closedStatus = useMemo(() => pickStatusForOpen(statuses, false), [statuses]);
  const activeBucket = buckets.find((b) => b.id === activeBucketId) ?? null;
  const bucketRows = useMemo(() => {
    if (!incidents || !activeBucket) return [];
    return incidentsInBucket(incidents, activeBucket);
  }, [incidents, activeBucket]);

  const patchIncident = (updated: ReportIncident) => {
    setIncidents((list) => (list ? list.map((i) => (i.incidentId === updated.incidentId ? updated : i)) : list));
  };

  const applyStatus = async (incident: ReportIncident, statusId: number, label: string, confirm = true) => {
    if (projectId === null) return;
    if (incident.statusId === statusId) return;
    if (confirm && !window.confirm(`Set IN:${incident.incidentId} to "${label}" in Spira?`)) return;
    setBusyId(incident.incidentId);
    try {
      const updated = await updateIncidentStatus(projectId, incident.incidentId, statusId);
      patchIncident(updated);
      toast.success(`IN:${updated.incidentId} is now ${updated.status ?? label}.`);
    } catch (err) {
      toast.error(errorMessage(err));
      throw err;
    } finally {
      setBusyId(null);
    }
  };

  const bulkStatus = async (wantOpen: boolean) => {
    if (projectId === null || !activeBucket) return;
    const status = wantOpen ? openStatus : closedStatus;
    if (!status) {
      toast.error(wantOpen ? "No open status is configured in Spira." : "No closed status is configured in Spira.");
      return;
    }
    const targets = bucketRows.filter((r) => r.open !== wantOpen);
    if (targets.length === 0) {
      toast.message(wantOpen ? "Everything in this bucket is already open." : "Everything in this bucket is already closed.");
      return;
    }
    if (!window.confirm(`Set ${targets.length} defect${targets.length === 1 ? "" : "s"} to "${status.name}" in Spira?`)) return;
    setBulkBusy(true);
    let ok = 0;
    try {
      for (const row of targets) {
        await applyStatus(row, status.id, status.name, false);
        ok += 1;
      }
      toast.success(`Updated ${ok} of ${targets.length} in Spira.`);
    } catch {
      toast.error(`Stopped after ${ok} of ${targets.length}. Fix the Spira error and try again.`);
    } finally {
      setBulkBusy(false);
    }
  };

  const createFromSelection = () => {
    if (projectId === null || selected.size === 0) return;
    try {
      const bucket = addBucket(projectId, bucketName || `Review (${selected.size})`, [...selected]);
      setBucketName("");
      setSelected(new Set());
      reloadBuckets();
      setActiveBucketId(bucket.id);
      toast.success(`Bucket “${bucket.name}” saved with ${bucket.incidentIds.length} defects.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const loadDescription = useCallback(
    async (incidentId: number, force = false) => {
      if (projectId === null) return;
      if (!force && descStarted.current.has(incidentId)) return;
      descStarted.current.add(incidentId);
      setDescLoadingIds((prev) => new Set(prev).add(incidentId));
      try {
        const { description } = await readIncidentDescription(projectId, incidentId);
        setDescDrafts((d) => ({ ...d, [incidentId]: description }));
        setDescSaved((d) => ({ ...d, [incidentId]: description }));
      } catch (err) {
        toast.error(`IN:${incidentId}: ${errorMessage(err)}`);
        setDescDrafts((d) => (d[incidentId] === undefined ? { ...d, [incidentId]: "" } : d));
      } finally {
        setDescLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(incidentId);
          return next;
        });
      }
    },
    [projectId],
  );

  const bucketIncidentKey = useMemo(() => bucketRows.map((r) => r.incidentId).join(","), [bucketRows]);

  // Prefetch Spira descriptions so each card opens with an editable text box.
  useEffect(() => {
    if (!activeBucket || projectId === null || !bucketIncidentKey) return;
    for (const id of bucketIncidentKey.split(",").map(Number).filter((n) => n > 0)) {
      void loadDescription(id);
    }
  }, [activeBucket?.id, bucketIncidentKey, projectId, loadDescription]);

  const saveDescription = async (incidentId: number) => {
    if (projectId === null) return;
    const text = descDrafts[incidentId];
    if (text === undefined) return;
    setBusyId(incidentId);
    try {
      const updated = await writeIncidentDescription(projectId, incidentId, text);
      patchIncident(updated);
      setDescSaved((d) => ({ ...d, [incidentId]: text }));
      toast.success(`Saved description for IN:${incidentId} in Spira.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleAllVisible = (on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (on) next.add(r.incidentId);
        else next.delete(r.incidentId);
      }
      return next;
    });
  };

  if (!configured || projectId === null) {
    return (
      <EmptyState icon={Search} title="Choose a Spira project in Settings">
        The register reads every incident in the project and updates status in Spira.
      </EmptyState>
    );
  }

  if (activeBucket) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => setActiveBucketId(null)}>
            Back to register
          </Button>
          <h2 className="text-lg font-semibold tracking-tight">{activeBucket.name}</h2>
          <Badge tone="neutral">{bucketRows.length} defects</Badge>
        </div>
        <p className="text-sm text-slate-600 dark:text-zinc-400">
          Edit each Spira description, then mark open or closed. Close/open writes straight to Spira.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={CheckCircle2} busy={bulkBusy} disabled={bulkBusy || !closedStatus} onClick={() => void bulkStatus(false)}>
            Mark all closed in Spira
          </Button>
          <Button size="sm" icon={LockOpen} busy={bulkBusy} disabled={bulkBusy || !openStatus} onClick={() => void bulkStatus(true)}>
            Mark all open in Spira
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            onClick={() => {
              if (!window.confirm(`Delete bucket “${activeBucket.name}”? Spira defects are not deleted.`)) return;
              removeBucket(projectId, activeBucket.id);
              setActiveBucketId(null);
              reloadBuckets();
            }}
          >
            Delete bucket
          </Button>
        </div>

        {bucketRows.length === 0 ? (
          <EmptyState icon={FolderPlus} title="No matching incidents">
            These ids are not in the loaded list (refresh the register), or they were removed from Spira.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            {bucketRows.map((row) => {
              const busy = busyId === row.incidentId || bulkBusy;
              const draft = descDrafts[row.incidentId];
              return (
                <div key={row.incidentId} className="rounded-xl border border-slate-200 p-4 dark:border-white/10">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        <SpiraIncidentLink href={incidentUrl(row.incidentId)} incidentId={row.incidentId} />
                        <span className="text-slate-700 dark:text-zinc-200"> · {row.name}</span>
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {row.severity ?? "—"} · {row.priority ?? "—"} · {row.detectedRelease ?? "no release"}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={row.open ? "warning" : "success"}>{row.status ?? (row.open ? "Open" : "Closed")}</Badge>
                      {later.has(row.incidentId) && <Badge tone="brand">For later</Badge>}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <select
                      className="input w-auto min-w-[9rem]"
                      aria-label={`Status for IN:${row.incidentId}`}
                      disabled={busy || statuses.length === 0}
                      value={row.statusId && statuses.some((s) => s.id === row.statusId) ? String(row.statusId) : ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === FOR_LATER_SELECT) {
                          markForLater(row.incidentId, true);
                          return;
                        }
                        const id = Number(value);
                        const status = statuses.find((s) => s.id === id);
                        if (status) void applyStatus(row, status.id, status.name);
                      }}
                    >
                      <option value="" disabled>
                        Choose status…
                      </option>
                      <option value={FOR_LATER_SELECT}>For Later (app only)</option>
                      {statuses.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.open ? "" : " (closed)"}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Bookmark}
                      onClick={() => markForLater(row.incidentId, !later.has(row.incidentId))}
                    >
                      {later.has(row.incidentId) ? "Clear For later" : "For later"}
                    </Button>
                    {row.open && closedStatus && (
                      <Button size="sm" variant="ghost" icon={CheckCircle2} busy={busy} disabled={busy} onClick={() => void applyStatus(row, closedStatus.id, closedStatus.name)}>
                        Mark closed
                      </Button>
                    )}
                    {!row.open && openStatus && (
                      <Button size="sm" variant="ghost" icon={LockOpen} busy={busy} disabled={busy} onClick={() => void applyStatus(row, openStatus.id, openStatus.name)}>
                        Mark open
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (!activeBucket) return;
                        const next = { ...activeBucket, incidentIds: activeBucket.incidentIds.filter((id) => id !== row.incidentId) };
                        updateBucket(projectId, next);
                        reloadBuckets();
                      }}
                    >
                      Remove from bucket
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-col gap-2">
                    <label className="text-sm font-medium text-slate-700 dark:text-zinc-300" htmlFor={`desc-${row.incidentId}`}>
                      Edit description (Spira)
                    </label>
                    {draft === undefined || descLoadingIds.has(row.incidentId) ? (
                      <div className="flex items-center gap-2 text-sm text-slate-500">
                        <Spinner /> Loading description from Spira…
                      </div>
                    ) : (
                      <>
                        <textarea
                          id={`desc-${row.incidentId}`}
                          className="input min-h-36 text-sm leading-relaxed"
                          value={draft}
                          onChange={(e) => setDescDrafts((d) => ({ ...d, [row.incidentId]: e.target.value }))}
                          disabled={busy}
                          placeholder="Write or edit the defect description…"
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            busy={busy}
                            disabled={busy || draft === descSaved[row.incidentId]}
                            onClick={() => void saveDescription(row.incidentId)}
                          >
                            Save description to Spira
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || draft === descSaved[row.incidentId]}
                            onClick={() => setDescDrafts((d) => ({ ...d, [row.incidentId]: descSaved[row.incidentId] ?? "" }))}
                          >
                            Discard edits
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || descLoadingIds.has(row.incidentId)}
                            onClick={() => {
                              descStarted.current.delete(row.incidentId);
                              void loadDescription(row.incidentId, true);
                            }}
                          >
                            Reload from Spira
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.incidentId));

  return (
    <div className="flex flex-col gap-4">
      {buckets.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-slate-700 dark:text-zinc-300">Saved buckets</p>
          <div className="flex flex-wrap gap-2">
            {buckets.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setActiveBucketId(b.id)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-brand-400 dark:border-white/10 dark:bg-white/5"
              >
                <FolderPlus className="size-3.5 text-slate-400" aria-hidden />
                {b.name}
                <span className="text-xs text-slate-500">{b.incidentIds.length}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700 dark:text-zinc-300">Search</span>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Id, name, or status" aria-label="Search defects" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700 dark:text-zinc-300">Show</span>
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value as IncidentOpenFilter)} aria-label="Open or closed">
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700 dark:text-zinc-300">Sort</span>
          <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as IncidentSort)} aria-label="Sort order">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <Button icon={RefreshCw} busy={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-brand-200 bg-brand-50/60 p-3 dark:border-brand-500/30 dark:bg-brand-500/10">
          <p className="w-full text-sm font-medium text-slate-800 dark:text-zinc-200">{selected.size} selected</p>
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">Bucket name</span>
            <input
              className="input"
              value={bucketName}
              maxLength={MAX_BUCKET_NAME}
              onChange={(e) => setBucketName(e.target.value)}
              placeholder={`Review (${selected.size})`}
            />
          </label>
          <Button icon={FolderPlus} onClick={createFromSelection}>
            Create bucket
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {!complete && incidents && (
        <Notice tone="warning" title="List may be incomplete">
          Spira returned the most recent incidents only (cap 5,000). Older defects may be missing.
        </Notice>
      )}

      {error && (
        <Notice tone="danger" title="Could not load defects">
          {error}
        </Notice>
      )}

      {loading && !incidents && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading every incident in this project…
        </div>
      )}

      {incidents && rows.length === 0 && !loading && (
        <EmptyState icon={Search} title={filter === "forLater" ? "Nothing marked For later" : filter === "open" ? "No open defects" : "No matching defects"}>
          {query.trim()
            ? "Try a different search."
            : filter === "forLater"
              ? "Pick For Later on a defect to park it here (app only — Spira is unchanged)."
              : filter === "open"
                ? "Everything in Spira for this project is closed, or there are no incidents yet."
                : "Nothing matched these filters."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-white/5 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                    aria-label="Select all visible"
                  />
                </th>
                <th className="px-3 py-2">Id</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Detected</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Update in Spira</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {rows.map((row) => {
                const busy = busyId === row.incidentId;
                const on = selected.has(row.incidentId);
                return (
                  <tr key={row.incidentId} className="align-top">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (on) next.delete(row.incidentId);
                            else next.add(row.incidentId);
                            return next;
                          });
                        }}
                        aria-label={`Select IN:${row.incidentId}`}
                      />
                    </td>
                    <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                      <SpiraIncidentLink href={incidentUrl(row.incidentId)} incidentId={row.incidentId} />
                    </td>
                    <td className="max-w-[18rem] px-3 py-2">
                      <span className="line-clamp-2">{row.name}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex flex-col gap-1">
                        <Badge tone={row.open ? "warning" : "success"}>{row.status ?? (row.open ? "Open" : "Closed")}</Badge>
                        {later.has(row.incidentId) && <Badge tone="brand">For later</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{row.severity ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{row.priority ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{row.detectedRelease ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{formatDateTime(row.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className="input w-auto min-w-[9rem]"
                          aria-label={`Status for IN:${row.incidentId}`}
                          disabled={busy || statuses.length === 0}
                          value={row.statusId && statuses.some((s) => s.id === row.statusId) ? String(row.statusId) : ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            if (value === FOR_LATER_SELECT) {
                              markForLater(row.incidentId, true);
                              return;
                            }
                            const id = Number(value);
                            const status = statuses.find((s) => s.id === id);
                            if (status) void applyStatus(row, status.id, status.name);
                          }}
                        >
                          <option value="" disabled>
                            {statuses.length ? "Choose status…" : "No statuses"}
                          </option>
                          <option value={FOR_LATER_SELECT}>For Later (app only)</option>
                          {statuses.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                              {s.open ? "" : " (closed)"}
                            </option>
                          ))}
                        </select>
                        <Button size="sm" variant="ghost" icon={Bookmark} onClick={() => markForLater(row.incidentId, !later.has(row.incidentId))}>
                          {later.has(row.incidentId) ? "Clear For later" : "For later"}
                        </Button>
                        {row.open && closedStatus && (
                          <Button size="sm" variant="ghost" icon={CheckCircle2} busy={busy} disabled={busy} onClick={() => void applyStatus(row, closedStatus.id, closedStatus.name)}>
                            Mark closed
                          </Button>
                        )}
                        {!row.open && openStatus && (
                          <Button size="sm" variant="ghost" icon={LockOpen} busy={busy} disabled={busy} onClick={() => void applyStatus(row, openStatus.id, openStatus.name)}>
                            Mark open
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500 dark:border-white/5 dark:text-zinc-500">
            Showing {rows.length.toLocaleString()} of {incidents!.length.toLocaleString()} incidents in project {projectId}.
          </p>
        </div>
      )}
    </div>
  );
}
