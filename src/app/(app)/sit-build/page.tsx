import type { Metadata } from "next";
import { UatBuildWorkspace } from "../uat-build/uat-build-workspace";

export const metadata: Metadata = { title: "SIT build" };

export default async function SitBuildPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const initial =
    tab === "defects" || tab === "smoke" || tab === "cases" ? (tab as "cases" | "defects" | "smoke") : undefined;
  return <UatBuildWorkspace cycle="sit" initialTab={initial} />;
}
