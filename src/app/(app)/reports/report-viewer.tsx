"use client";

import { Download, FileSpreadsheet, Link2, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui";
import type { Report } from "@/lib/domain/report";
import { ReportDocument, type ReportChanges } from "./report-document";

const readAt = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * The generated report over the page. It prints on its own: everything behind it is hidden from print,
 * and the browser's "Save as PDF" names the file after the report.
 */
export function ReportViewer({
  report,
  changes,
  siteUrl,
  fileName,
  onShare,
  onExcel,
  onClose,
}: {
  report: Report;
  changes: ReportChanges | null;
  siteUrl: string | null;
  fileName: string;
  onShare: () => void;
  onExcel: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose]);

  const downloadPdf = () => {
    const title = document.title;
    document.title = fileName;
    window.addEventListener("afterprint", () => (document.title = title), { once: true });
    window.print();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/55 backdrop-blur-sm print:static print:block print:bg-transparent print:backdrop-blur-none"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-6 print:hidden dark:border-white/10 dark:bg-zinc-900">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-semibold">
            {report.title}
          </h2>
          <p className="text-xs text-slate-500 dark:text-zinc-400">Read from Spira {readAt(report.generatedAt)}</p>
        </div>
        <Button size="sm" variant="primary" icon={Download} onClick={downloadPdf}>
          Download PDF
        </Button>
        <Button size="sm" icon={Link2} onClick={onShare}>
          Share link
        </Button>
        <Button size="sm" icon={FileSpreadsheet} onClick={onExcel}>
          Excel
        </Button>
        <Button ref={closeRef} size="sm" variant="ghost" icon={X} onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-6 sm:px-8 print:overflow-visible print:p-0">
        <div className="mx-auto max-w-[1280px]">
          <ReportDocument report={report} changes={changes} siteUrl={siteUrl} />
        </div>
      </div>
    </div>
  );
}
