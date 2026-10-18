const A4 = { width: 297, height: 210 };
const MARGIN = 8;
/** Capture width matching the on-screen report (desktop layout, full tables). */
const EXPORT_WIDTH_PX = 1180;
/** Last slice shorter than this share of a sheet is merged into fewer taller slices. */
const ORPHAN_RATIO = 0.45;

type JsPdf = import("jspdf").jsPDF;

/**
 * Split a tall capture into slice heights. A short leftover (one row + footer) is absorbed
 * so the PDF does not get a nearly blank sheet.
 */
export function planPdfSlices(heightPx: number, maxSlicePx: number, orphanRatio = ORPHAN_RATIO): number[] {
  const height = Math.max(1, Math.ceil(heightPx));
  const maxSlice = Math.max(1, Math.floor(maxSlicePx));
  if (height <= maxSlice) return [height];

  let pages = Math.ceil(height / maxSlice);
  const remainder = height - (pages - 1) * maxSlice;
  if (pages > 1 && remainder / maxSlice < orphanRatio) pages -= 1;

  const slice = Math.ceil(height / pages);
  const out: number[] = [];
  let y = 0;
  for (let i = 0; i < pages; i++) {
    const h = i === pages - 1 ? height - y : Math.min(slice, height - y);
    if (h > 0) out.push(h);
    y += h;
  }
  return out.length ? out : [height];
}

/**
 * Saves the report as a PDF: each on-screen report page is captured at desktop width
 * (same look as the share link), laid out on A4 landscape, and split across sheets when tall
 * so text stays readable instead of being squashed onto one page.
 */
export async function downloadReportPdf(root: HTMLElement, fileName: string): Promise<void> {
  const pages = [...root.querySelectorAll<HTMLElement>(".report-page")];
  if (pages.length === 0) throw new Error("The report has no pages to save.");
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  await document.fonts?.ready;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  let pdf: JsPdf | null = null;
  const usableW = A4.width - 2 * MARGIN;
  const usableH = A4.height - 2 * MARGIN;
  const pixelRatio = Math.min(2.5, typeof window !== "undefined" ? window.devicePixelRatio || 2 : 2);

  for (const page of pages) {
    const prevWidth = page.style.width;
    const prevMax = page.style.maxWidth;
    const prevShadow = page.style.boxShadow;
    const prevBorder = page.style.border;
    const prevRadius = page.style.borderRadius;
    const overflowRestores: Array<{ el: HTMLElement; overflow: string }> = [];
    try {
      page.style.width = `${EXPORT_WIDTH_PX}px`;
      page.style.maxWidth = `${EXPORT_WIDTH_PX}px`;
      page.style.boxShadow = "none";
      page.style.border = "0";
      page.style.borderRadius = "0";
      page.querySelectorAll<HTMLElement>(".overflow-x-auto").forEach((el) => {
        overflowRestores.push({ el, overflow: el.style.overflow });
        el.style.overflow = "visible";
      });
      // Relayout at export width before measuring.
      void page.offsetHeight;

      const canvas = await toCanvas(page, {
        pixelRatio,
        backgroundColor: "#ffffff",
        width: EXPORT_WIDTH_PX,
        height: page.scrollHeight,
        style: {
          width: `${EXPORT_WIDTH_PX}px`,
          maxWidth: `${EXPORT_WIDTH_PX}px`,
          boxShadow: "none",
          border: "0",
          borderRadius: "0",
          margin: "0",
          background: "#ffffff",
          color: "#0f172a",
        },
      });

      // Fit to page width (landscape); slice vertically when the page is taller than one sheet.
      const widthScale = usableW / canvas.width;
      const pageSlicePx = Math.max(1, Math.floor(usableH / widthScale));
      const slices = planPdfSlices(canvas.height, pageSlicePx);
      let offsetY = 0;

      for (const slicePx of slices) {
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.max(1, Math.ceil(slicePx));
        const ctx = slice.getContext("2d");
        if (!ctx) throw new Error("Could not prepare the PDF page.");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, offsetY, canvas.width, slicePx, 0, 0, canvas.width, slicePx);

        if (pdf) pdf.addPage("a4", "landscape");
        else pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });

        // Taller absorbed slices scale down slightly so they still fit the sheet.
        const fit = Math.min(widthScale, usableH / slicePx);
        const wMm = canvas.width * fit;
        const hMm = slicePx * fit;
        const xMm = MARGIN + (usableW - wMm) / 2;
        pdf.addImage(slice.toDataURL("image/jpeg", 0.95), "JPEG", xMm, MARGIN, wMm, hMm, undefined, "MEDIUM");
        offsetY += slicePx;
      }
    } finally {
      page.style.width = prevWidth;
      page.style.maxWidth = prevMax;
      page.style.boxShadow = prevShadow;
      page.style.border = prevBorder;
      page.style.borderRadius = prevRadius;
      for (const { el, overflow } of overflowRestores) el.style.overflow = overflow;
    }
  }

  pdf!.setProperties({ title: fileName, creator: "Spira Test Set Reconciler" });
  pdf!.save(`${fileName}.pdf`);
}
