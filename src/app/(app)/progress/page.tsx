import type { Metadata } from "next";
import { ProgressWorkspace } from "./progress-workspace";

export const metadata: Metadata = { title: "Progress" };

export default function ProgressPage() {
  return <ProgressWorkspace />;
}
