"use client";

import { ArrowLeft, Smartphone } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useSettings } from "@/components/settings-context";
import { ButtonLink, EmptyState, Spinner } from "@/components/ui";
import {
  getMatrixSession,
  matrixModuleLabel,
  prodModuleLabel,
} from "@/lib/client/matrix";
import { listUatDrafts } from "@/lib/client/uat-build";

/**
 * Legacy bucket URLs (`/matrix/[sessionId]`) redirect into the shared Execute UI
 * at `/matrix/run/[draftId]?device=&network=`.
 */
export function MatrixExecute() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const { settings } = useSettings();
  const projectId = settings?.projectId ?? null;
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (projectId === null) return;
    const session = getMatrixSession(projectId, params.sessionId);
    if (!session) {
      setMissing(true);
      return;
    }
    const want = (prodModuleLabel(session.module ?? "") ?? matrixModuleLabel(session.module ?? "")).toLowerCase();
    const draft = listUatDrafts(session.releaseId).find(
      (d) => (prodModuleLabel(d.module) ?? matrixModuleLabel(d.module)).toLowerCase() === want,
    );
    if (!draft) {
      setMissing(true);
      return;
    }
    const q = new URLSearchParams({ device: session.device, network: session.network });
    router.replace(`/matrix/run/${draft.id}?${q.toString()}`);
  }, [projectId, params.sessionId, router]);

  if (projectId === null) {
    return (
      <EmptyState icon={Smartphone} title="No project" action={<ButtonLink href="/settings">Open Settings</ButtonLink>}>
        Save Settings, then open Matrix again.
      </EmptyState>
    );
  }

  if (missing) {
    return (
      <EmptyState icon={Smartphone} title="Bucket not found" action={<ButtonLink href="/matrix" icon={ArrowLeft}>Back to Matrix</ButtonLink>}>
        That matrix bucket is missing, or its module draft is not loaded. Open it again from Matrix.
      </EmptyState>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Spinner /> Opening Execute…
    </div>
  );
}
