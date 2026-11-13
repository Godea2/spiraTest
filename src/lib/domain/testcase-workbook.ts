/** Pure helpers for the professional SIT/UAT testcase Excel pack. */

export type CaseRow = {
  "TC ID": number;
  Name: string;
  Module: string;
  Platform: string;
  "Test set": string;
  Priority: string;
  Status: string;
  "Last run": string;
  Link: string;
};

export type StatusKey = "Passed" | "Failed" | "Blocked" | "Caution" | "Not Run" | "Other";

export const STATUS_ORDER: StatusKey[] = ["Passed", "Failed", "Blocked", "Caution", "Not Run", "Other"];

export function normalizeCaseStatus(status: string): StatusKey {
  const s = status.trim().toLowerCase();
  if (s === "passed") return "Passed";
  if (s === "failed") return "Failed";
  if (s === "blocked") return "Blocked";
  if (s === "caution") return "Caution";
  if (s === "not run" || s === "n/a" || s === "not applicable" || s === "") return "Not Run";
  return "Other";
}

export function safeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]+/g, "-").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Map export rows (Module/Platform/…) into the workbook CaseRow shape. */
export function toCaseRows(rows: Array<Record<string, unknown>>): CaseRow[] {
  return rows.map((r) => ({
    "TC ID": Number(r["TC ID"] ?? 0),
    Name: String(r.Name ?? ""),
    Module: String(r.Module ?? "Other"),
    Platform: String(r.Platform ?? ""),
    "Test set": String(r["Test set"] ?? ""),
    Priority: String(r.Priority ?? ""),
    Status: String(r.Status ?? "Not Run"),
    "Last run": String(r["Last run"] ?? ""),
    Link: String(r.Link ?? ""),
  }));
}

export type ModuleStatusCount = {
  Module: string;
  Platform: string;
  Passed: number;
  Failed: number;
  Blocked: number;
  Caution: number;
  "Not Run": number;
  Other: number;
  Total: number;
  "Pass rate": string;
};

export function summarizeByModulePlatform(rows: CaseRow[]): ModuleStatusCount[] {
  const map = new Map<string, ModuleStatusCount>();
  for (const row of rows) {
    const key = `${row.Module}\0${row.Platform}`;
    let cur = map.get(key);
    if (!cur) {
      cur = {
        Module: row.Module,
        Platform: row.Platform,
        Passed: 0,
        Failed: 0,
        Blocked: 0,
        Caution: 0,
        "Not Run": 0,
        Other: 0,
        Total: 0,
        "Pass rate": "—",
      };
      map.set(key, cur);
    }
    const status = normalizeCaseStatus(row.Status);
    cur[status] += 1;
    cur.Total += 1;
  }
  return [...map.values()]
    .map((r) => {
      const executed = r.Passed + r.Failed + r.Blocked + r.Caution;
      r["Pass rate"] = executed === 0 ? "—" : `${Math.round((r.Passed / executed) * 100)}%`;
      return r;
    })
    .sort(
      (a, b) =>
        a.Module.localeCompare(b.Module) || a.Platform.localeCompare(b.Platform),
    );
}

export function groupRowsByModule(rows: CaseRow[]): Map<string, CaseRow[]> {
  const map = new Map<string, CaseRow[]>();
  for (const row of rows) {
    const list = map.get(row.Module) ?? [];
    list.push(row);
    map.set(row.Module, list);
  }
  for (const [, list] of map) {
    list.sort(
      (a, b) =>
        a.Platform.localeCompare(b.Platform) ||
        a["Test set"].localeCompare(b["Test set"]) ||
        a["TC ID"] - b["TC ID"],
    );
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function groupRowsByStatus(rows: CaseRow[]): Map<StatusKey, CaseRow[]> {
  const map = new Map<StatusKey, CaseRow[]>();
  for (const key of STATUS_ORDER) map.set(key, []);
  for (const row of rows) {
    const status = normalizeCaseStatus(row.Status);
    map.get(status)!.push(row);
  }
  for (const [, list] of map) {
    list.sort(
      (a, b) =>
        a.Module.localeCompare(b.Module) ||
        a.Platform.localeCompare(b.Platform) ||
        a["TC ID"] - b["TC ID"],
    );
  }
  return map;
}

export function overallCounts(rows: CaseRow[]): Record<StatusKey, number> & { Total: number } {
  const out = { Passed: 0, Failed: 0, Blocked: 0, Caution: 0, "Not Run": 0, Other: 0, Total: rows.length };
  for (const row of rows) out[normalizeCaseStatus(row.Status)] += 1;
  return out;
}
