import { MAX_ATTACHMENT_BYTES } from "@/lib/domain/defect-report";
import type { AttachmentKind } from "@/lib/domain/types";

/** A file picked for a defect, ready to upload: images already made smaller. */
export interface PendingFile {
  id: string;
  blob: Blob;
  name: string;
  kind: AttachmentKind;
  size: number;
  /** Size before it was made smaller; equal to size when it was kept as it was. */
  originalSize: number;
  caption: string;
  /** Object URL for an image's thumbnail; release it with releaseFiles. */
  preview: string | null;
}

/** Longest side of an image sent to Spira: sharp enough to read a phone or desktop screenshot. */
const MAX_IMAGE_EDGE = 2_000;
/** Images this small, and no larger than MAX_IMAGE_EDGE, go as they are. */
const KEEP_IMAGE_BELOW = 1_200_000;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const EXTENSIONS: Record<string, AttachmentKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  pdf: "file",
  txt: "file",
  log: "file",
  json: "file",
  csv: "file",
};

/** What the file picker offers. */
export const ACCEPTED_FILES = [...IMAGE_TYPES, ...VIDEO_TYPES, "application/pdf", ...Object.keys(EXTENSIONS).map((e) => `.${e}`)].join(",");

export const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function kindOf(file: File): AttachmentKind | null {
  if (IMAGE_TYPES.has(file.type)) return "image";
  if (VIDEO_TYPES.has(file.type)) return "video";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSIONS[ext] ?? null;
}

/** A pasted screenshot is called image.png: give it a name that says when it was taken. */
function nameOf(file: File): string {
  if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const at = new Date(file.lastModified || Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  return `screenshot-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.png`;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be made smaller."))), type, quality));
}

/**
 * Makes a screenshot small enough to send: at most MAX_IMAGE_EDGE on its longest side, kept as PNG
 * when that is small (crisp text), otherwise JPEG. GIFs keep their animation and go as they are.
 */
async function shrinkImage(file: File, name: string): Promise<{ blob: Blob; name: string }> {
  if (file.type === "image/gif") return { blob: file, name };
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= KEEP_IMAGE_BELOW) return { blob: file, name };
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return { blob: file, name };
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const base = name.replace(/\.[^.]*$/, "");
    if (file.type === "image/png") {
      const png = await encode(canvas, "image/png");
      if (png.size <= KEEP_IMAGE_BELOW) return { blob: png, name: `${base}.png` };
    }
    for (const quality of [0.88, 0.75, 0.6]) {
      const jpeg = await encode(canvas, "image/jpeg", quality);
      if (jpeg.size <= MAX_ATTACHMENT_BYTES || quality === 0.6) return { blob: jpeg.size < file.size ? jpeg : file, name: jpeg.size < file.size ? `${base}.jpg` : name };
    }
    return { blob: file, name };
  } finally {
    bitmap.close();
  }
}

/** Checks a picked or pasted file and makes images smaller. Throws a message for the tester when it cannot go. */
export async function prepareFile(file: File): Promise<PendingFile> {
  const kind = kindOf(file);
  const name = nameOf(file);
  if (!kind) throw new Error(`${name}: attach images, videos (MP4, MOV, WebM), PDFs or text logs.`);
  let blob: Blob = file;
  let finalName = name;
  if (kind === "image") {
    try {
      ({ blob, name: finalName } = await shrinkImage(file, name));
    } catch {
      throw new Error(`${name} could not be read as an image.`);
    }
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    const hint = kind === "video" ? " Trim the recording, or attach it in Spira." : "";
    throw new Error(`${name} is ${formatSize(blob.size)}; files up to ${formatSize(MAX_ATTACHMENT_BYTES)} can be attached here.${hint}`);
  }
  return {
    id: crypto.randomUUID(),
    blob,
    name: finalName,
    kind,
    size: blob.size,
    originalSize: file.size,
    caption: "",
    preview: kind === "image" ? URL.createObjectURL(blob) : null,
  };
}

export function releaseFiles(files: PendingFile[]): void {
  for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
}

export async function toBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

/** Files on the clipboard or dropped, in order. */
export function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files.length > 0) return [...data.files];
  return [...data.items].flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}
