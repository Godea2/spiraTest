import { api } from "@/lib/client/api";
import type { ReportIncident } from "@/lib/domain/types";

export function listProjectIncidents(projectId: number): Promise<{ incidents: ReportIncident[]; complete: boolean }> {
  return api("/api/reports/incidents", { method: "POST", body: { projectId } });
}

export function updateIncidentStatus(projectId: number, incidentId: number, statusId: number): Promise<ReportIncident> {
  return api("/api/spira/incident-status", { method: "POST", body: { projectId, incidentId, statusId } });
}

export function readIncidentDescription(projectId: number, incidentId: number): Promise<{ incidentId: number; description: string }> {
  return api("/api/spira/incident-description", { method: "POST", body: { projectId, incidentId } });
}

export function writeIncidentDescription(projectId: number, incidentId: number, description: string): Promise<ReportIncident> {
  return api("/api/spira/incident-description", { method: "PUT", body: { projectId, incidentId, description } });
}
