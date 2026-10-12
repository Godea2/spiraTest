import type { Metadata } from "next";
import { ReportWorkspace } from "./report-workspace";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return <ReportWorkspace />;
}
