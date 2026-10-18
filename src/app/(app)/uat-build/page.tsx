import type { Metadata } from "next";
import { UatBuildWorkspace } from "./uat-build-workspace";

export const metadata: Metadata = { title: "UAT build" };

export default async function UatBuildPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  const initial =
    tab === "defects" || tab === "smoke" || tab === "cases" ? (tab as "cases" | "defects" | "smoke") : undefined;
  return <UatBuildWorkspace initialTab={initial} />;
}
