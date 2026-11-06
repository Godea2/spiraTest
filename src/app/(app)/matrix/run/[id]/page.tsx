"use client";

import { Suspense, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Execute } from "@/app/(app)/drafts/[id]/execute/execute";
import { useSettings } from "@/components/settings-context";
import { Spinner } from "@/components/ui";
import { setActiveMatrixCell, clearActiveMatrixCell } from "@/lib/client/matrix-context";
import { MATRIX_DEVICES, MATRIX_NETWORKS, platformForDevice, type MatrixDevice, type MatrixNetwork } from "@/lib/domain/matrix";

function isDevice(value: string | null): value is MatrixDevice {
  return !!value && (MATRIX_DEVICES as readonly string[]).includes(value);
}

function isNetwork(value: string | null): value is MatrixNetwork {
  return !!value && (MATRIX_NETWORKS as readonly string[]).includes(value);
}

function MatrixRunInner() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const { settings } = useSettings();
  const device = search.get("device");
  const network = search.get("network");

  useEffect(() => {
    const projectId = settings?.projectId ?? null;
    const releaseId = settings?.releaseId ?? null;
    if (projectId === null || releaseId === null || !isDevice(device) || !isNetwork(network)) return;
    setActiveMatrixCell({
      projectId,
      releaseId,
      releaseLabel: settings?.releaseLabel?.trim() || `RL:${releaseId}`,
      device,
      network,
    });
    return () => clearActiveMatrixCell();
  }, [settings?.projectId, settings?.releaseId, settings?.releaseLabel, device, network]);

  const cellOk = isDevice(device) && isNetwork(network);
  const cellLabel = cellOk ? `${device} · ${network}` : "Matrix";
  const platformFilter = isDevice(device) ? platformForDevice(device) : null;

  return (
    <Execute
      id={params.id}
      backHref="/matrix"
      backLabel={`Matrix (${cellLabel})`}
      hideBoard
      platformFilter={platformFilter}
      matrixCell={cellOk ? { device, network } : null}
    />
  );
}

/** Same Execute runner as UAT build, with Matrix device × network locked for the coverage board. */
export default function MatrixRunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Loading…
        </div>
      }
    >
      <MatrixRunInner />
    </Suspense>
  );
}
