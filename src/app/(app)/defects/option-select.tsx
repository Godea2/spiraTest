"use client";

import type { IncidentOptions } from "@/lib/domain/types";

/** One of the project's incident lists (type, severity, priority); empty means Spira's default. */
export function OptionSelect({ label, list, value, onChange }: { label: string; list: IncidentOptions["types"] | undefined; value: number | null; onChange: (id: number | null) => void }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select className="input" value={value ?? ""} disabled={!list} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{list ? "Spira default" : "Loading…"}</option>
        {(list ?? []).map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
