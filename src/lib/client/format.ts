import type { DraftStatus } from "@/lib/domain/types";

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDateTime(iso);
}

export const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: "Draft",
  applied: "Applied",
  appliedWithErrors: "Applied with errors",
};

export const STATUS_TONE: Record<DraftStatus, "neutral" | "success" | "danger"> = {
  draft: "neutral",
  applied: "success",
  appliedWithErrors: "danger",
};
