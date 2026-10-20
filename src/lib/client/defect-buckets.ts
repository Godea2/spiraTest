import { readItem, writeItem } from "@/lib/client/storage";
import { createBucket, type DefectBucket } from "@/lib/domain/incident-register";

function key(projectId: number): string {
  return `defect-buckets:${projectId}`;
}

export function listBuckets(projectId: number): DefectBucket[] {
  const rows = readItem<DefectBucket[]>(key(projectId)) ?? [];
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveBuckets(projectId: number, buckets: DefectBucket[]): void {
  writeItem(key(projectId), buckets);
}

export function addBucket(projectId: number, name: string, incidentIds: number[]): DefectBucket {
  const bucket = createBucket(projectId, name, incidentIds);
  saveBuckets(projectId, [bucket, ...listBuckets(projectId).filter((b) => b.id !== bucket.id)]);
  return bucket;
}

export function updateBucket(projectId: number, bucket: DefectBucket): void {
  const next = { ...bucket, updatedAt: new Date().toISOString() };
  saveBuckets(
    projectId,
    listBuckets(projectId).map((b) => (b.id === next.id ? next : b)),
  );
}

export function removeBucket(projectId: number, bucketId: string): void {
  saveBuckets(
    projectId,
    listBuckets(projectId).filter((b) => b.id !== bucketId),
  );
}
