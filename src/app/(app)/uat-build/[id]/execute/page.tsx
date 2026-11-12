"use client";

import { Execute } from "@/app/(app)/drafts/[id]/execute/execute";
import { useSettings } from "@/components/settings-context";
import { buildWorkspaceLabel, softDetectCycle } from "@/lib/domain/settings";
import { use } from "react";

export default function UatExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { settings } = useSettings();
  const cycle = softDetectCycle(settings?.releaseId ?? null, settings?.releaseLabel ?? "");
  const buildLabel = buildWorkspaceLabel(cycle);

  return <Execute id={id} backHref="/uat-build" backLabel={buildLabel} hideBoard />;
}
