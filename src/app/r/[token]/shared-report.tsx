"use client";

import { Download, FileChartColumn, Radio } from "lucide-react";
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { Toaster } from "sonner";
import { Button } from "@/components/ui";
import { usePdfDownload } from "@/app/(app)/reports/use-pdf-download";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const noop = () => () => undefined;
/** Times are shown in the viewer's own time zone, so they are only written once the page is in the browser. */
const useInBrowser = () => useSyncExternalStore(noop, () => true, () => false);

/** A shared report on its own page: the report, its PDF download, and nothing of the app around it. */
export function SharedReport({
  title,
  project,
  generatedAt,
  expiresAt,
  fileName,
  children,
}: {
  title: string;
  project: string;
  generatedAt: string;
  expiresAt: string;
  fileName: string;
  children: ReactNode;
}) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const pdf = usePdfDownload(pagesRef, fileName);
  const inBrowser = useInBrowser();
  return (
    <div className="min-h-dvh bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-3 px-4 py-3 sm:px-8">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-violet-600 text-white shadow-sm">
            <FileChartColumn className="size-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">{title}</h1>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                <Radio className="size-3.5" aria-hidden /> Live from Spira
              </span>
              <span>
                {project}
                {inBrowser && ` · read ${when(generatedAt)}`}
              </span>
            </p>
          </div>
          <Button size="sm" variant="primary" icon={Download} busy={pdf.busy} onClick={pdf.download}>
            {pdf.busy ? "Preparing PDF…" : "Download PDF"}
          </Button>
        </div>
      </header>
      <main className="px-3 py-6 sm:px-8">
        <div ref={pagesRef} className="mx-auto max-w-[1280px]">
          {children}
        </div>
        <p className="mx-auto mt-6 max-w-[1280px] text-center text-xs text-slate-500 print:hidden">
          Read-only report shared from SpiraTest.{inBrowser && ` This link works until ${day(expiresAt)}.`}
        </p>
      </main>
      <Toaster theme="light" position="bottom-right" richColors closeButton />
    </div>
  );
}
