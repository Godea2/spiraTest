import { defaultNotesSelection, type NotesItem, type NotesParseResult } from "@/lib/domain/notes";
import { fitsPlatform, matchImportModules } from "@/lib/domain/progress-import";
import type { Draft } from "@/lib/domain/types";
import { api, ApiError, errorMessage } from "./api";
import {
  searchProgress,
  type ProgressCase,
  type ProgressPick,
} from "./progress";

export type { NotesItem, NotesParseResult };

export interface MappedNotesItem {
  item: NotesItem;
  matches: ProgressCase[];
  selected: Set<string>;
  error: string | null;
}

export type NotesMapPhase = { done: number; total: number; label: string };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

async function askGemini<T>(path: string, body: unknown): Promise<T> {
  try {
    return await api<T>(path, { method: "POST", body });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 503) throw error;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    return api<T>(path, { method: "POST", body });
  }
}

/** Gemini splits informal notes into done / left bullets. */
export function parseNotes(notes: string, modules: string[]): Promise<NotesParseResult> {
  return askGemini<NotesParseResult>("/api/ai/notes/parse", { notes, modules });
}

/**
 * Maps each note bullet to Spira cases. Done items pre-tick at most one case; left items are
 * matched for review only (no auto-select for recording).
 */
export async function mapNotesItems(
  items: NotesItem[],
  drafts: Draft[],
  onPhase?: (phase: NotesMapPhase) => void,
): Promise<MappedNotesItem[]> {
  const modules = [...new Set(drafts.map((d) => d.module))];
  const out: MappedNotesItem[] = [];
  let done = 0;
  const total = items.length;

  for (const item of items) {
    onPhase?.({ done, total, label: clip(item.text, 60) });
    const moduleNames = matchImportModules(item.moduleHint || item.text, modules);
    const scoped = drafts.filter((d) => moduleNames.includes(d.module));
    const withPlatform = (list: typeof drafts) =>
      list
        .map((d) => ({
          ...d,
          testSets: d.testSets.filter((s) => fitsPlatform(s.testSetName, item.platform)),
        }))
        .filter((d) => d.testSets.length > 0);
    const searchDrafts = withPlatform(scoped.length ? scoped : drafts);
    const fallback = searchDrafts.length ? searchDrafts : scoped.length ? scoped : drafts;

    if (fallback.length === 0) {
      out.push({ item, matches: [], selected: new Set(), error: "No In Scope cases in the modules this note names." });
      done += 1;
      onPhase?.({ done, total, label: clip(item.text, 60) });
      continue;
    }

    try {
      const search = await searchProgress(fallback, item.text, () => {});
      const matches = search.cases.filter((c) => fitsPlatform(c.target.testSetName, item.platform));
      const selected = defaultNotesSelection(
        item,
        matches.map((c) => ({
          key: `${c.target.draftId}|${c.target.card.key}`,
          name: c.target.card.name,
          relevance: c.candidate.relevance,
        })),
      );
      out.push({ item, matches, selected, error: search.unreadError });
    } catch (err) {
      out.push({ item, matches: [], selected: new Set(), error: errorMessage(err) });
    }
    done += 1;
    onPhase?.({ done, total, label: clip(item.text, 60) });
  }
  return out;
}

/** Pass picks from done notes only (left items never become writes). */
export function picksFromNotes(mapped: MappedNotesItem[]): ProgressPick[] {
  const picks: ProgressPick[] = [];
  const seen = new Set<string>();
  for (const m of mapped) {
    if (m.item.bucket !== "done") continue;
    const comment = clip(`[Notes] ${m.item.text}`, 1_500);
    for (const c of m.matches) {
      const key = `${c.target.draftId}|${c.target.card.key}`;
      if (!m.selected.has(key) || seen.has(key)) continue;
      seen.add(key);
      picks.push({ target: c.target, status: "passed", comment });
    }
  }
  return picks;
}
