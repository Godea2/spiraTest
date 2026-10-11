import type { Metadata } from "next";
import { DefectWorkspace } from "./defect-workspace";

export const metadata: Metadata = { title: "Defects" };

export default async function DefectsPage({ searchParams }: { searchParams: Promise<{ draft?: string | string[] }> }) {
  const { draft } = await searchParams;
  return <DefectWorkspace from={typeof draft === "string" ? draft : null} />;
}
