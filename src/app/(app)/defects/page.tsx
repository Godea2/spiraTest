"use client";

import clsx from "clsx";
import { Bug, ClipboardList } from "lucide-react";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, Spinner } from "@/components/ui";
import { DefectRegister } from "./defect-register";
import { DefectWorkspace } from "./defect-workspace";

type Tab = "log" | "review";

const TABS: { id: Tab; label: string; icon: typeof Bug; hint: string }[] = [
  { id: "log", label: "Log", icon: Bug, hint: "Find cases and raise a new incident" },
  { id: "review", label: "Review", icon: ClipboardList, hint: "Every project defect; update open or closed in Spira" },
];

function DefectsBody() {
  const searchParams = useSearchParams();
  const from = searchParams.get("draft");
  const [tab, setTab] = useState<Tab>(from ? "log" : "review");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Defects"
        description={
          tab === "log"
            ? "Describe a defect once. Gemini looks for the cases it breaks; you fail them in Spira and link one incident."
            : "Every incident in this Spira project (SIT, UAT, all releases). Change status in Spira when you have reviewed it."
        }
      />

      <div role="tablist" aria-label="Defects" className="flex flex-wrap gap-2">
        {TABS.map(({ id, label, icon: Icon, hint }) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              title={hint}
              onClick={() => setTab(id)}
              className={clsx(
                "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition",
                selected
                  ? "bg-brand-600 text-white shadow-sm dark:bg-brand-500"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      {tab === "log" ? <DefectWorkspace from={from} embedded /> : <DefectRegister />}
    </div>
  );
}

export default function DefectsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading…
        </div>
      }
    >
      <DefectsBody />
    </Suspense>
  );
}
