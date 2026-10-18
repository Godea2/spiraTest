import type { Metadata } from "next";
import { Execute } from "@/app/(app)/drafts/[id]/execute/execute";

export const metadata: Metadata = { title: "UAT build · Execute" };

export default async function UatExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Execute id={id} backHref="/uat-build" backLabel="UAT build" hideBoard />;
}
