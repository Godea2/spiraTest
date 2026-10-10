import "server-only";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { ActivityEntry } from "@/lib/domain/types";
import { appendLine, dataPath } from "./json-store";

const activityFile = () => dataPath("activity.jsonl");

export async function logActivity(
  entry: Omit<ActivityEntry, "id" | "at" | "draftId" | "module" | "details"> &
    Partial<Pick<ActivityEntry, "draftId" | "module" | "details">>,
): Promise<ActivityEntry> {
  const full: ActivityEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    draftId: entry.draftId ?? null,
    module: entry.module ?? null,
    details: entry.details ?? null,
    type: entry.type,
    message: entry.message,
  };
  await appendLine(activityFile(), JSON.stringify(full));
  return full;
}

export async function listActivity(limit = 1000): Promise<ActivityEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(activityFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ActivityEntry);
    } catch {
      // A torn final line from an interrupted write is skipped rather than failing the whole log.
    }
  }
  return entries.reverse().slice(0, limit);
}
