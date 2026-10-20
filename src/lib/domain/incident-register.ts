import type { IncidentStatusOption, ReportIncident } from "./types";

export type IncidentOpenFilter = "all" | "open" | "closed";
export type IncidentSort = "id" | "created" | "name";

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
): ReportIncident[] {
  const q = query.trim().toLowerCase();
  return incidents.filter((i) => {
    if (filter === "open" && !i.open) return false;
    if (filter === "closed" && i.open) return false;
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
