import { runSignature } from "./execution";
import type { AttachmentKind } from "./types";

/** Files one defect can carry. */
export const MAX_ATTACHMENTS = 10;
/** Largest file sent to Spira: one file per request, and base64 adds a third, under the host's 4.5 MB request limit. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Base64 characters for the largest file. */
export const MAX_ATTACHMENT_BASE64 = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
export const MAX_CAPTION = 300;
export const MAX_ENVIRONMENT = 300;

/** Spira's artifact type ids for what a file is attached to. */
export const ARTIFACT_TYPE = { incident: 3, testRun: 5 } as const;

const TEXT_EXTENSIONS = new Set(["txt", "log", "json", "csv"]);

/** What a file really is, from its first bytes; the name a browser gives it is not trusted. */
export function detectAttachment(bytes: Uint8Array, name: string): { kind: AttachmentKind; ext: string } | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  const ascii = (at: number, len: number) => String.fromCharCode(...bytes.slice(at, at + len));
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", ext: "png" };
  if (starts([0xff, 0xd8, 0xff])) return { kind: "image", ext: "jpg" };
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { kind: "image", ext: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { kind: "image", ext: "webp" };
  if (ascii(0, 5) === "%PDF-") return { kind: "file", ext: "pdf" };
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return { kind: "video", ext: "webm" };
  if (ascii(4, 4) === "ftyp") return { kind: "video", ext: ascii(8, 2) === "qt" ? "mov" : "mp4" };
  // Text logs: valid UTF-8 without control bytes other than tabs and line breaks.
  if (bytes.length === 0 || bytes.some((b) => b < 9 || b === 11 || b === 12 || (b > 13 && b < 32))) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const ext = extensionOf(name);
  return { kind: "file", ext: TEXT_EXTENSIONS.has(ext) ? ext : "txt" };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A safe file name for Spira: no path, plain characters, and the extension of what the file really is. */
export function attachmentFileName(name: string, ext: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[^\w\s.()-]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .trim()
    .slice(0, 100);
  return `${base || "attachment"}.${ext}`;
}

/** Marks a file this app attached for a defect; undo only deletes files carrying it. */
export function attachmentSignature(runner: string): string {
  return `Attached for a defect ${runSignature(runner)}`;
}

/** The description a file gets in Spira: its caption, then the signature. */
export function attachmentDescription(caption: string, runner: string): string {
  return [caption.trim(), attachmentSignature(runner)].filter(Boolean).join("\n");
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A file to show in the incident: inline when it is an image. */
export interface ReportFile {
  documentId: number;
  name: string;
  caption: string;
  kind: AttachmentKind;
}

/** The incident's section for its files, linked to Spira; images also shown inline. */
export function attachmentsHtml(files: ReportFile[], link: (documentId: number) => string | null): string {
  if (files.length === 0) return "";
  const parts = [`<p><strong>${files.some((f) => f.kind === "image") ? "Screenshots and files" : "Files"}</strong></p>`];
  for (const f of files) {
    const url = link(f.documentId);
    const name = escapeHtml(f.name);
    const caption = f.caption.trim() ? ` ${escapeHtml(f.caption.trim())}` : "";
    const named = url ? `<a href="${escapeHtml(url)}">${name}</a>` : name;
    const image = f.kind === "image" && url ? `<a href="${escapeHtml(url)}"><img src="${escapeHtml(url)}" alt="${name}" style="max-width:100%" /></a><br />` : "";
    parts.push(`<p>${image}${named}${caption}</p>`);
  }
  return parts.join("");
}

/**
 * The incident's description as Spira rich text. Lines starting "## " are headings, runs of "- " lines
 * are lists, and other lines are paragraphs (a blank line ends one). Everything is escaped. The extra
 * HTML (the files) goes before the failed test cases, or at the end.
 */
export function reportHtml(text: string, extra = ""): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let placed = extra === "";
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("<br />")}</p>`);
    if (list.length) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    para = [];
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("## ")) {
      flush();
      const heading = line.slice(3).trim();
      if (!placed && /^failed test cases/i.test(heading)) {
        out.push(extra);
        placed = true;
      }
      out.push(`<p><strong>${escapeHtml(heading)}</strong></p>`);
    } else if (line.startsWith("- ")) {
      if (para.length) flush();
      list.push(escapeHtml(line.slice(2)));
    } else if (!line.trim()) {
      flush();
    } else {
      if (list.length) flush();
      const indent = /^ */.exec(line)![0].length;
      para.push(`${"&nbsp;".repeat(indent)}${escapeHtml(line.slice(indent))}`);
    }
  }
  flush();
  if (!placed) out.push(extra);
  return out.join("");
}
