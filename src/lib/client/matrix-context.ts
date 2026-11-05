/**
 * Active Matrix cell for this browser: when Execute records a Spira run, the same mark
 * is also stored on the device × network coverage board.
 */
import { environmentLabel, type MatrixDevice, type MatrixNetwork } from "@/lib/domain/matrix";
import { storeEnvironment } from "@/lib/client/defects";
import { readItem, writeItem, removeItem } from "@/lib/client/storage";

const KEY = "matrix-active-cell";

export interface ActiveMatrixCell {
  projectId: number;
  releaseId: number;
  releaseLabel: string;
  device: MatrixDevice;
  network: MatrixNetwork;
}

export function setActiveMatrixCell(cell: ActiveMatrixCell): void {
  writeItem(KEY, cell);
  storeEnvironment(`${environmentLabel(cell.device, cell.network)} · ${cell.releaseLabel}`);
}

export function getActiveMatrixCell(): ActiveMatrixCell | null {
  return readItem<ActiveMatrixCell>(KEY);
}

export function clearActiveMatrixCell(): void {
  removeItem(KEY);
}
