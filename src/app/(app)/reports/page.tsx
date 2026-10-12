import type { Metadata } from "next";
import { ReportWorkspace } from "./report-workspace";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ share?: string | string[] }> }) {
  const { share } = await searchParams;
  return <ReportWorkspace share={typeof share === "string" ? share : null} />;
}
