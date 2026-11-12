import type { Metadata } from "next";
import { CompareWorkspace } from "../compare-workspace";

export const metadata: Metadata = { title: "Compare" };

/** Still available by URL; hidden from the main nav for now. */
export default function ComparePage() {
  return <CompareWorkspace />;
}
