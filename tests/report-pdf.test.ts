import { describe, expect, it } from "vitest";
import { planPdfSlices } from "@/lib/client/report-pdf";

describe("planPdfSlices", () => {
  it("keeps a short page as one slice", () => {
    expect(planPdfSlices(800, 1000)).toEqual([800]);
  });

  it("splits evenly when content fills multiple sheets", () => {
    expect(planPdfSlices(2000, 1000)).toEqual([1000, 1000]);
  });

  it("absorbs a short orphan leftover instead of a nearly blank last sheet", () => {
    // 1100px on a 1000px sheet would leave a 100px orphan (~10%).
    expect(planPdfSlices(1100, 1000)).toEqual([1100]);
    // 1400px orphan is 40% — still absorbed at the 45% threshold.
    expect(planPdfSlices(1400, 1000)).toEqual([1400]);
    // 1600px orphan is 60% — keep two sheets, split evenly.
    expect(planPdfSlices(1600, 1000)).toEqual([800, 800]);
  });
});
