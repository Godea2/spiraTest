"use client";

import clsx from "clsx";
import { FileText, Film, ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui";
import { ACCEPTED_FILES, filesFrom, formatSize, prepareFile, releaseFiles, type PendingFile } from "@/lib/client/attachments";
import { errorMessage } from "@/lib/client/api";
import { MAX_ATTACHMENT_BYTES, MAX_CAPTION } from "@/lib/domain/defect-report";

/**
 * Screenshots and files for a defect: pasted (Ctrl+V anywhere on the page, unless another dialog is
 * open), dropped or picked. Images are made smaller in the browser before they are sent.
 */
export function AttachmentPicker({
  files,
  onChange,
  max,
  disabled,
}: {
  files: PendingFile[];
  onChange: (update: (files: PendingFile[]) => PendingFile[]) => void;
  max: number;
  disabled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(0);
  const [over, setOver] = useState(false);
  const room = max - files.length - preparing;

  const add = async (picked: File[]) => {
    if (disabled || picked.length === 0) return;
    const take = picked.slice(0, Math.max(0, room));
    if (take.length < picked.length) toast.warning(`A defect can have at most ${max} files; ${picked.length - take.length} left out.`);
    setPreparing((n) => n + take.length);
    for (const file of take) {
      try {
        const ready = await prepareFile(file);
        onChange((list) => [...list, ready]);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setPreparing((n) => n - 1);
      }
    }
  };
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const node = box.current;
      if (!node) return;
      const dialog = document.querySelector("dialog[open]");
      if (dialog && !dialog.contains(node)) return;
      const pasted = filesFrom(event.clipboardData);
      if (pasted.length === 0) return;
      event.preventDefault();
      void addRef.current(pasted);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const remove = (id: string) =>
    onChange((list) => {
      releaseFiles(list.filter((f) => f.id === id));
      return list.filter((f) => f.id !== id);
    });

  return (
    <div ref={box} className="flex flex-col gap-2">
      <div
        className={clsx(
          "flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-sm transition",
          over ? "border-brand-400 bg-brand-50/60 dark:bg-brand-500/10" : "border-slate-300 dark:border-white/15",
          disabled && "opacity-60",
        )}
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void add(filesFrom(e.dataTransfer));
        }}
      >
        <ImagePlus className="size-5 shrink-0 text-slate-400" aria-hidden />
        <span className="min-w-0 flex-1 text-slate-600 dark:text-zinc-400">
          Paste a screenshot (Ctrl+V), drop files here or{" "}
          <button type="button" className="cursor-pointer font-medium text-brand-700 underline dark:text-brand-300" disabled={disabled || room <= 0} onClick={() => input.current?.click()}>
            choose files
          </button>
          . Images, screen recordings, PDFs or logs up to {formatSize(MAX_ATTACHMENT_BYTES)}; screenshots are made smaller first.
        </span>
        <span className="text-xs text-slate-500 tabular-nums">
          {files.length} of {max}
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPTED_FILES}
          className="hidden"
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      {(files.length > 0 || preparing > 0) && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {files.map((f) => (
            <li key={f.id} className="flex gap-3 rounded-xl border border-slate-200 p-2 dark:border-white/10">
              <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100 dark:bg-white/[0.06]">
                {f.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset
                  <img src={f.preview} alt="" className="size-full object-cover" />
                ) : f.kind === "video" ? (
                  <Film className="size-6 text-slate-400" aria-hidden />
                ) : (
                  <FileText className="size-6 text-slate-400" aria-hidden />
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium" title={f.name}>{f.name}</span>
                    <span className="block text-[11px] text-slate-500">
                      {formatSize(f.size)}
                      {f.size < f.originalSize && ` (from ${formatSize(f.originalSize)})`}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10"
                    aria-label={`Remove ${f.name}`}
                    disabled={disabled}
                    onClick={() => remove(f.id)}
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
                <input
                  className="input h-8 text-xs"
                  placeholder="Caption (optional)"
                  value={f.caption}
                  maxLength={MAX_CAPTION}
                  disabled={disabled}
                  aria-label={`Caption for ${f.name}`}
                  onChange={(e) => {
                    const caption = e.target.value;
                    onChange((list) => list.map((x) => (x.id === f.id ? { ...x, caption } : x)));
                  }}
                />
              </div>
            </li>
          ))}
          {preparing > 0 && (
            <li className="flex items-center gap-2 rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-500 dark:border-white/10">
              <Spinner /> Preparing {preparing} file{preparing === 1 ? "" : "s"}…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
