"use client";

import { Download, FileSpreadsheet, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui";
import { exportMatrixReportWorkbook } from "@/lib/client/matrix-report-excel";
import { matrixReportFileName, type MatrixReport } from "@/lib/domain/matrix-report";
import { MatrixReportDocument } from "./matrix-report-document";
import { usePdfDownload } from "./use-pdf-download";

const readAt = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Same shell as the Spira executive report viewer: PDF + Excel + close. */
export function MatrixReportViewer({ report, onClose }: { report: MatrixReport; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const fileName = matrixReportFileName(report);
  const pdf = usePdfDownload(pagesRef, fileName);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [onClose]);

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
          <p className="text-xs text-slate-500 dark:text-zinc-400">Prod Testing report · {readAt(report.generatedAt)}</p>
        </div>
        <Button size="sm" variant="primary" icon={Download} busy={pdf.busy} onClick={pdf.download}>
          {pdf.busy ? "Preparing PDF…" : "Download PDF"}
        </Button>
        <Button size="sm" icon={FileSpreadsheet} onClick={() => void exportMatrixReportWorkbook(report)}>
          Excel
        </Button>
        <Button ref={closeRef} size="sm" variant="ghost" icon={X} onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-6 sm:px-8 print:overflow-visible print:p-0">
        <div ref={pagesRef} className="mx-auto max-w-[1280px]">
          <MatrixReportDocument report={report} />
        </div>
      </div>
    </div>
  );
}
