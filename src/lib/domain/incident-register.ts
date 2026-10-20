import type { IncidentStatusOption, ReportIncident } from "./types";

export type IncidentOpenFilter = "all" | "open" | "closed" | "forLater";
export type IncidentSort = "id" | "created" | "name";

/** Value used in the status select for the app-only "For Later" flag (never sent to Spira). */
export const FOR_LATER_SELECT = "local:for-later";

export const MAX_BUCKET_NAME = 120;
export const MAX_INCIDENT_DESCRIPTION = 50_000;

/** A named set of incidents for review, kept in this browser per Spira project. */
export interface DefectBucket {
  id: string;
  projectId: number;
  name: string;
  incidentIds: number[];
  createdAt: string;
  updatedAt: string;
}

/** Prefer an exact Closed / Open name, then any status with the matching open flag. */
export function pickStatusForOpen(statuses: IncidentStatusOption[], wantOpen: boolean): IncidentStatusOption | null {
  const named = wantOpen
    ? statuses.find((s) => /^open$/i.test(s.name.trim()))
    : statuses.find((s) => /^closed$/i.test(s.name.trim()));
  if (named && named.open === wantOpen) return named;
  return statuses.find((s) => s.open === wantOpen) ?? null;
}

export function filterIncidents(
  incidents: ReportIncident[],
  filter: IncidentOpenFilter,
  query: string,
  forLater: ReadonlySet<number> = new Set(),
): ReportIncident[] {
  const q = query.trim().toLowerCase();
  return incidents.filter((i) => {
    if (filter === "open" && !i.open) return false;
    if (filter === "closed" && i.open) return false;
    if (filter === "forLater" && !forLater.has(i.incidentId)) return false;
    if (!q) return true;
    return String(i.incidentId).includes(q) || i.name.toLowerCase().includes(q) || (i.status?.toLowerCase().includes(q) ?? false);
  });
}

export function sortIncidents(incidents: ReportIncident[], sort: IncidentSort): ReportIncident[] {
  const list = [...incidents];
  list.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name) || b.incidentId - a.incidentId;
    if (sort === "created") {
      const ac = a.createdAt ?? "";
      const bc = b.createdAt ?? "";
      return bc.localeCompare(ac) || b.incidentId - a.incidentId;
    }
    return b.incidentId - a.incidentId;
  });
  return list;
}

export function createBucket(projectId: number, name: string, incidentIds: number[], at = new Date().toISOString()): DefectBucket {
  const trimmed = name.trim().slice(0, MAX_BUCKET_NAME);
  const ids = [...new Set(incidentIds.filter((id) => id > 0))].sort((a, b) => b - a);
  return {
    id: `bucket-${projectId}-${Date.now().toString(36)}`,
    projectId,
    name: trimmed || `Bucket (${ids.length})`,
    incidentIds: ids,
    createdAt: at,
    updatedAt: at,
  };
}

export function incidentsInBucket(incidents: ReportIncident[], bucket: DefectBucket): ReportIncident[] {
  const want = new Set(bucket.incidentIds);
  return sortIncidents(
    incidents.filter((i) => want.has(i.incidentId)),
    "id",
  );
}
