import { api } from "@/lib/client/api";
import type { ReportIncident } from "@/lib/domain/types";

export function listProjectIncidents(projectId: number): Promise<{ incidents: ReportIncident[]; complete: boolean }> {
  return api("/api/reports/incidents", { method: "POST", body: { projectId } });
}

export function updateIncidentStatus(projectId: number, incidentId: number, statusId: number): Promise<ReportIncident> {
  return api("/api/spira/incident-status", { method: "POST", body: { projectId, incidentId, statusId } });
}
