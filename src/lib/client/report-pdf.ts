const A4 = { long: 297, short: 210 };
const MARGIN = 8;

/**
 * Saves the report as a PDF file: each report page is drawn as it looks on screen and placed on its own
 * A4 sheet, in whichever orientation shows it largest, so nothing is cut or stretched.
 */
export async function downloadReportPdf(root: HTMLElement, fileName: string): Promise<void> {
  const pages = [...root.querySelectorAll<HTMLElement>(".report-page")];
  if (pages.length === 0) throw new Error("The report has no pages to save.");
  const [{ toCanvas }, { jsPDF }] = await Promise.all([import("html-to-image"), import("jspdf")]);
  await document.fonts?.ready;

  let pdf: InstanceType<typeof jsPDF> | null = null;
  for (const page of pages) {
    const canvas = await toCanvas(page, { pixelRatio: 2, backgroundColor: "#ffffff", style: { boxShadow: "none", margin: "0" } });
    const fit = (width: number, height: number) => Math.min((width - 2 * MARGIN) / canvas.width, (height - 2 * MARGIN) / canvas.height);
    const landscape = fit(A4.long, A4.short) >= fit(A4.short, A4.long);
    const [width, height] = landscape ? [A4.long, A4.short] : [A4.short, A4.long];
    const scale = fit(width, height);
    const orientation = landscape ? "landscape" : "portrait";
    if (pdf) pdf.addPage("a4", orientation);
    else pdf = new jsPDF({ orientation, unit: "mm", format: "a4", compress: true });
    const w = canvas.width * scale;
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", (width - w) / 2, MARGIN, w, canvas.height * scale, undefined, "FAST");
  }
  pdf!.setProperties({ title: fileName, creator: "Spira Test Set Reconciler" });
  pdf!.save(`${fileName}.pdf`);
}
