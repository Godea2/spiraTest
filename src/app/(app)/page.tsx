import type { Metadata } from "next";
import { CompareWorkspace } from "./compare-workspace";

export const metadata: Metadata = { title: "Compare" };

export default function ComparePage() {
  return <CompareWorkspace />;
}
