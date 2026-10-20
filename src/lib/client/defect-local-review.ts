import { readItem, writeItem } from "@/lib/client/storage";

/** Local-only review flags per incident (not written to Spira). */
export interface LocalReviewFlags {
  forLater: boolean;
  updatedAt: string;
}

function key(projectId: number): string {
  return `defect-local-review:${projectId}`;
}

export function readLocalReview(projectId: number): Record<string, LocalReviewFlags> {
  return readItem<Record<string, LocalReviewFlags>>(key(projectId)) ?? {};
}

export function writeLocalReview(projectId: number, map: Record<string, LocalReviewFlags>): void {
  writeItem(key(projectId), map);
}

export function setForLater(projectId: number, incidentId: number, forLater: boolean): void {
  const map = readLocalReview(projectId);
  const id = String(incidentId);
  if (!forLater) {
    const { [id]: _, ...rest } = map;
    writeLocalReview(projectId, rest);
    return;
  }
  writeLocalReview(projectId, { ...map, [id]: { forLater: true, updatedAt: new Date().toISOString() } });
}

export function forLaterIds(projectId: number): Set<number> {
  const map = readLocalReview(projectId);
  return new Set(
    Object.entries(map)
      .filter(([, v]) => v.forLater)
      .map(([id]) => Number(id))
      .filter((id) => id > 0),
  );
}
