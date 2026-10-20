import { describe, expect, it } from "vitest";
import { createBucket, filterIncidents, incidentsInBucket, pickStatusForOpen, sortIncidents } from "@/lib/domain/incident-register";
import type { IncidentStatusOption, ReportIncident } from "@/lib/domain/types";

const status = (id: number, name: string, open: boolean): IncidentStatusOption => ({ id, name, open });

const row = (incidentId: number, extra: Partial<ReportIncident> = {}): ReportIncident => ({
  incidentId,
  name: `Defect ${incidentId}`,
  statusId: 1,
  status: "New",
  open: true,
  severity: "Medium",
  priority: "High",
  type: "Bug",
  detectedReleaseId: 2,
  detectedRelease: "1.0.0.0002",
  createdAt: "2026-10-11T09:00:00.000Z",
  closedAt: null,
  owner: null,
  opener: null,
  ...extra,
});

describe("pickStatusForOpen", () => {
  const list = [status(1, "New", true), status(2, "Assigned", true), status(3, "Closed", false), status(4, "Rejected", false)];

  it("prefers a status named Open or Closed", () => {
    expect(pickStatusForOpen([...list, status(5, "Open", true)], true)?.id).toBe(5);
    expect(pickStatusForOpen(list, false)?.name).toBe("Closed");
  });

  it("falls back to any matching open flag", () => {
    expect(pickStatusForOpen([status(9, "Resolved", false), status(8, "In progress", true)], true)?.id).toBe(8);
    expect(pickStatusForOpen([status(9, "Resolved", false)], false)?.id).toBe(9);
  });

  it("returns null when nothing matches", () => {
    expect(pickStatusForOpen([status(1, "New", true)], false)).toBeNull();
    expect(pickStatusForOpen([], true)).toBeNull();
  });
});

describe("filterIncidents and sortIncidents", () => {
  const incidents = [
    row(10, { name: "Login crash", open: true, createdAt: "2026-10-10T10:00:00.000Z" }),
    row(20, { name: "Payments timeout", open: false, status: "Closed", createdAt: "2026-10-12T10:00:00.000Z" }),
    row(15, { name: "Profile photo", open: true, createdAt: "2026-10-11T10:00:00.000Z" }),
  ];

  it("filters by open, for-later, and search", () => {
    expect(filterIncidents(incidents, "open", "").map((i) => i.incidentId)).toEqual([10, 15]);
    expect(filterIncidents(incidents, "closed", "").map((i) => i.incidentId)).toEqual([20]);
    expect(filterIncidents(incidents, "forLater", "", new Set([15, 99])).map((i) => i.incidentId)).toEqual([15]);
    expect(filterIncidents(incidents, "all", "pay").map((i) => i.incidentId)).toEqual([20]);
    expect(filterIncidents(incidents, "all", "15").map((i) => i.incidentId)).toEqual([15]);
  });

  it("sorts by id, created date, or name", () => {
    expect(sortIncidents(incidents, "id").map((i) => i.incidentId)).toEqual([20, 15, 10]);
    expect(sortIncidents(incidents, "created").map((i) => i.incidentId)).toEqual([20, 15, 10]);
    expect(sortIncidents(incidents, "name").map((i) => i.name)).toEqual(["Login crash", "Payments timeout", "Profile photo"]);
  });
});

describe("defect buckets", () => {
  it("creates a named bucket of unique incident ids", () => {
    const bucket = createBucket(24, "  Sprint review  ", [20, 10, 20, 15], "2026-10-20T08:00:00.000Z");
    expect(bucket).toMatchObject({ projectId: 24, name: "Sprint review", incidentIds: [20, 15, 10], createdAt: "2026-10-20T08:00:00.000Z" });
    expect(bucket.id).toMatch(/^bucket-24-/);
  });

  it("resolves bucket members from the loaded register", () => {
    const incidents = [row(10), row(20), row(30)];
    const bucket = createBucket(24, "Pick", [30, 10]);
    expect(incidentsInBucket(incidents, bucket).map((i) => i.incidentId)).toEqual([30, 10]);
  });
});
