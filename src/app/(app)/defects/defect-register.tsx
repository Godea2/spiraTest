"use client";

import { CheckCircle2, LockOpen, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSettings } from "@/components/settings-context";
import { Badge, Button, EmptyState, Notice, Spinner } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { listProjectIncidents, updateIncidentStatus } from "@/lib/client/incident-register";
import { readIncidentOptions } from "@/lib/client/defects";
import {
  filterIncidents,
  pickStatusForOpen,
  sortIncidents,
  type IncidentOpenFilter,
  type IncidentSort,
} from "@/lib/domain/incident-register";
import type { IncidentStatusOption, ReportIncident } from "@/lib/domain/types";

const FILTERS: { id: IncidentOpenFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "closed", label: "Closed" },
];

const SORTS: { id: IncidentSort; label: string }[] = [
  { id: "id", label: "Newest id" },
  { id: "created", label: "Newest created" },
  { id: "name", label: "Name" },
];

export function DefectRegister() {
  const { settings, spira } = useSettings();
  const projectId = settings?.projectId ?? null;
  const configured = spira?.configured === true;

  const [incidents, setIncidents] = useState<ReportIncident[] | null>(null);
  const [complete, setComplete] = useState(true);
  const [statuses, setStatuses] = useState<IncidentStatusOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<IncidentOpenFilter>("open");
  const [sort, setSort] = useState<IncidentSort>("id");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (projectId === null || !configured) return;
    setLoading(true);
    setError(null);
    try {
      const [list, options] = await Promise.all([listProjectIncidents(projectId), readIncidentOptions(projectId)]);
      setIncidents(list.incidents);
      setComplete(list.complete);
      setStatuses(options.statuses);
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
    return sortIncidents(filterIncidents(incidents, filter, query), sort);
  }, [incidents, filter, query, sort]);

  const openStatus = useMemo(() => pickStatusForOpen(statuses, true), [statuses]);
  const closedStatus = useMemo(() => pickStatusForOpen(statuses, false), [statuses]);

  const applyStatus = async (incident: ReportIncident, statusId: number, label: string) => {
    if (projectId === null) return;
    if (incident.statusId === statusId) return;
    if (!window.confirm(`Set IN:${incident.incidentId} to "${label}" in Spira?`)) return;
    setBusyId(incident.incidentId);
    try {
      const updated = await updateIncidentStatus(projectId, incident.incidentId, statusId);
      setIncidents((list) => (list ? list.map((i) => (i.incidentId === updated.incidentId ? updated : i)) : list));
      toast.success(`IN:${updated.incidentId} is now ${updated.status ?? label}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  if (!configured || projectId === null) {
    return (
      <EmptyState icon={Search} title="Choose a Spira project in Settings">
        The register reads every incident in the project and updates status in Spira.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm">
          <span className="font-medium text-slate-700 dark:text-zinc-300">Search</span>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Id, name, or status"
            aria-label="Search defects"
          />
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
        <EmptyState icon={Search} title={filter === "open" ? "No open defects" : "No matching defects"}>
          {query.trim() ? "Try a different search." : filter === "open" ? "Everything in Spira for this project is closed, or there are no incidents yet." : "Nothing matched these filters."}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-white/5 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2">Id</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Detected</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Closed</th>
                <th className="px-3 py-2">Update in Spira</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-white/5">
              {rows.map((row) => {
                const busy = busyId === row.incidentId;
                return (
                  <tr key={row.incidentId} className="align-top">
                    <td className="px-3 py-2 font-medium tabular-nums whitespace-nowrap">IN:{row.incidentId}</td>
                    <td className="max-w-[18rem] px-3 py-2">
                      <span className="line-clamp-2">{row.name}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Badge tone={row.open ? "warning" : "success"}>{row.status ?? (row.open ? "Open" : "Closed")}</Badge>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{row.severity ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{row.priority ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{row.detectedRelease ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{formatDateTime(row.createdAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-zinc-400">{formatDateTime(row.closedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className="input w-auto min-w-[9rem]"
                          aria-label={`Status for IN:${row.incidentId}`}
                          disabled={busy || statuses.length === 0}
                          value={row.statusId && statuses.some((s) => s.id === row.statusId) ? String(row.statusId) : ""}
                          onChange={(e) => {
                            const id = Number(e.target.value);
                            const status = statuses.find((s) => s.id === id);
                            if (status) void applyStatus(row, status.id, status.name);
                          }}
                        >
                          <option value="" disabled>
                            {statuses.length ? "Choose status…" : "No statuses"}
                          </option>
                          {statuses.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                              {s.open ? "" : " (closed)"}
                            </option>
                          ))}
                        </select>
                        {row.open && closedStatus && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={CheckCircle2}
                            busy={busy}
                            disabled={busy}
                            onClick={() => void applyStatus(row, closedStatus.id, closedStatus.name)}
                          >
                            Mark closed
                          </Button>
                        )}
                        {!row.open && openStatus && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={LockOpen}
                            busy={busy}
                            disabled={busy}
                            onClick={() => void applyStatus(row, openStatus.id, openStatus.name)}
                          >
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
