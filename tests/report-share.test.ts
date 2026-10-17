import { describe, expect, it } from "vitest";
import { defaultReportOptions, type ReportOptions } from "@/lib/domain/report";
import { collectReportData } from "@/lib/domain/report-read";
import type { ReportCatalog, ReportCase, TestSetMapping } from "@/lib/domain/types";
import { createPublicShare, createShareToken, formatShareCode, isShortShareCode, readShareToken, resolveShare } from "@/lib/server/report-share";

const NOW = Date.parse("2026-10-12T20:00:00Z");
const options: ReportOptions = {
  ...defaultReportOptions(),
  kind: "buildVsPlan",
  title: "Project-Simba — Daily SIT Test Report",
  scoped: { releaseId: 2, folderId: null },
  baseline: { releaseId: 1, folderId: null },
  defectNotes: { "258": { feature: "Wallet", phase: "out", rationale: "Phase 2" } },
};
const mappings: TestSetMapping[] = [{ id: "m1", testSetId: 20, testSetName: "Payments - iOS", platform: "iOS", module: "Payments" }];

describe("public report links", () => {
  it("carries the report's setup, signed, until it expires", () => {
    const { token, expiresAt } = createShareToken({ projectId: 24, options, mappings, days: 30, now: NOW });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(expiresAt).toBe("2026-11-11T20:00:00.000Z");
    expect(readShareToken(token, NOW)).toEqual({ ok: true, projectId: 24, options, mappings, expiresAt });
    expect(readShareToken(token, Date.parse(expiresAt) + 1000)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a link that was edited or cut short", () => {
    const { token } = createShareToken({ projectId: 24, options, mappings, days: 7, now: NOW });
    const [body, sig] = token.split(".");
    const other = createShareToken({ projectId: 25, options, mappings, days: 7, now: NOW }).token.split(".")[0];
    expect(readShareToken(`${other}.${sig}`, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(readShareToken(`${body}.${sig.slice(0, -2)}`, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(readShareToken(body, NOW)).toEqual({ ok: false, reason: "invalid" });
    expect(readShareToken("not-a-link", NOW)).toEqual({ ok: false, reason: "invalid" });
  });

  it("does not trust a link signed with another secret", () => {
    const { token } = createShareToken({ projectId: 24, options, mappings, days: 7, now: NOW });
    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "another-session-secret-0123456789";
    try {
      expect(readShareToken(token, NOW)).toEqual({ ok: false, reason: "invalid" });
    } finally {
      process.env.SESSION_SECRET = secret;
    }
  });

  it("uses dated short codes, not the long signed token", () => {
    const { token } = createShareToken({ projectId: 24, options, mappings, days: 7, now: NOW });
    expect(formatShareCode(NOW, "k3m2")).toBe("2026-10-12-k3m2");
    expect(isShortShareCode("2026-10-17-k3m2")).toBe(true);
    expect(isShortShareCode("xY7k2m9pQz")).toBe(true);
    expect(isShortShareCode(token)).toBe(false);
  });

  it("requires shared storage so the URL stays short", async () => {
    await expect(createPublicShare({ projectId: 24, options, mappings, days: 7, now: NOW })).rejects.toThrow(/Supabase|shared storage/i);
    const { token, expiresAt } = createShareToken({ projectId: 24, options, mappings, days: 7, now: NOW });
    await expect(resolveShare(token, NOW)).resolves.toMatchObject({ ok: true, projectId: 24, expiresAt });
  });
});

describe("report data", () => {
  it("reads both scopes once, and the defects linked to failures in this build", async () => {
    const catalog = {
      projectId: 24,
      projectName: "Project-Simba",
      releases: [
        { releaseId: 1, versionNumber: "1.0.0.0001", label: "1.0.0.0001", depth: 0, parentId: null, active: true },
        { releaseId: 2, versionNumber: "1.0.0.0002", label: "1.0.0.0002", depth: 0, parentId: null, active: true },
      ],
      folders: [],
      testSets: [
        { testSetId: 10, releaseId: 1, folderId: null },
        { testSetId: 20, releaseId: 2, folderId: null },
        { testSetId: 21, releaseId: 2, folderId: null },
      ],
      readAt: "",
    } as unknown as ReportCatalog;
    const tc = (testCaseId: number, statusId: number | null) => ({ testCaseId, statusId }) as ReportCase;
    const asked: number[][] = [];
    const input = await collectReportData({
      catalog,
      options,
      mappings,
      reader: {
        results: async (ids) => {
          asked.push(ids);
          return Object.fromEntries(ids.map((id) => [id, id === 20 ? [tc(1, 1), tc(2, 2)] : [tc(3, null)]]));
        },
        links: async (ids) => ({ links: Object.fromEntries(ids.map((id) => [id, [258]])), incidents: [] }),
        incidents: async () => ({ incidents: [], complete: true }),
      },
    });
    expect(asked.flat().sort()).toEqual([10, 20, 21]);
    expect(input.links).toEqual({ 1: [258] });
    expect(input.incidentsComplete).toBe(true);
  });
});
