/**
 * Informal tester notes (WhatsApp-style done / what’s left lists) → structured bullets for Spira mapping.
 */
import { defaultImportSelection, type ImportMatchPick } from "./progress-import";
import type { Platform } from "./types";

export const MAX_NOTES_TEXT = 12_000;
export const MAX_NOTES_ITEMS = 80;

export type NotesBucket = "done" | "left";

export interface NotesItem {
  /** Stable id for UI keys (index-based after parse). */
  id: string;
  text: string;
  bucket: NotesBucket;
  moduleHint: string;
  platform: Platform | "both" | null;
}

export interface NotesParseResult {
  title: string;
  items: NotesItem[];
}

/** Raw Gemini item before ids are assigned. */
export interface NotesRawItem {
  text: string;
  bucket: NotesBucket;
  moduleHint: string;
  platform: "iOS" | "Android" | "both" | "unknown" | "";
}

export interface NotesMatchPick extends ImportMatchPick {
  /** Spira display name on the card, e.g. "Passed", "Failed", "Not Run". */
  executionStatus?: string;
}

/**
 * Cases already Passed or Failed in Spira are left alone — Notes never overwrites them.
 */
export function isSettledNotesStatus(executionStatus: string | null | undefined): boolean {
  const s = (executionStatus ?? "").trim().toLowerCase();
  return s === "passed" || s === "failed";
}

/**
 * Normalises Gemini output: trims, drops empties, caps count, assigns stable ids.
 * Platform "unknown"/empty → null.
 */
export function shapeNotesParse(title: string, raw: NotesRawItem[]): NotesParseResult {
  const items: NotesItem[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const text = row.text.trim().replace(/\s+/g, " ");
    if (text.length < 4) continue;
    const key = `${row.bucket}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const platform =
      row.platform === "iOS" || row.platform === "Android" || row.platform === "both" ? row.platform : null;
    items.push({
      id: `n${items.length + 1}`,
      text: text.slice(0, 500),
      bucket: row.bucket === "left" ? "left" : "done",
      moduleHint: row.moduleHint.trim().slice(0, 120),
      platform,
    });
    if (items.length >= MAX_NOTES_ITEMS) break;
  }
  return { title: title.trim().slice(0, 200) || "Tester notes", items };
}

/**
 * Pre-ticks at most one Spira case for a done note (same discipline as smoke).
 * Left items never auto-select. Already Passed/Failed matches are ignored.
 */
export function defaultNotesSelection(item: NotesItem, matches: NotesMatchPick[]): Set<string> {
  if (item.bucket !== "done") return new Set();
  const open = matches.filter((m) => !isSettledNotesStatus(m.executionStatus));
  return defaultImportSelection("smoke", { uatRef: "", caseName: item.text }, open);
}
