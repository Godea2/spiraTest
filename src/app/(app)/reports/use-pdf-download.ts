"use client";

import { useState, type RefObject } from "react";
import { toast } from "sonner";
import { downloadReportPdf } from "@/lib/client/report-pdf";

/** Saves the report pages inside `ref` as a PDF file named after the report. */
export function usePdfDownload(ref: RefObject<HTMLElement | null>, fileName: string) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!ref.current || busy) return;
    setBusy(true);
    try {
      await downloadReportPdf(ref.current, fileName);
    } catch (error) {
      console.error("PDF export failed", error);
      toast.error("The PDF could not be made in this browser. Use the browser's Print and choose Save as PDF instead.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, download: () => void download() };
}
