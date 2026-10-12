"use client";

import { Copy, ExternalLink, Globe, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Notice } from "@/components/ui";
import { errorMessage } from "@/lib/client/api";
import { createShareLink } from "@/lib/client/report";
import type { ReportOptions } from "@/lib/domain/report";
import type { TestSetMapping } from "@/lib/domain/types";

const DAYS = [7, 30, 90] as const;

const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export interface ShareRequest {
  projectId: number;
  options: ReportOptions;
  mappings: TestSetMapping[];
}

/** Creates a public, read-only link to the report, after the user chooses how long it lasts. */
export function ShareDialog({ request, onClose }: { request: ShareRequest; onClose: () => void }) {
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      window.prompt("Copy this link", url);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createShareLink({ ...request, days });
      setLink(created);
      await copy(created.url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Globe className="size-5 text-brand-600 dark:text-brand-400" aria-hidden /> Share this report
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!link && (
            <Button variant="primary" icon={Link2} busy={busy} onClick={() => void create()}>
              Create link
            </Button>
          )}
        </>
      }
    >
      <p>
        Anyone with the link can view this report without signing in. It opens only this report, never the app, and cannot change anything in Spira. The figures are
        read live from Spira each time it is opened, so it always shows the latest results.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <Field label="Link expires after">
          {(props) => (
            <select
              {...props}
              className="input"
              value={days}
              disabled={busy}
              onChange={(e) => {
                setDays(Number(e.target.value) as (typeof DAYS)[number]);
                setLink(null);
              }}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          )}
        </Field>
        {link && (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input className="input min-w-0 flex-1 font-mono text-xs" readOnly value={link.url} aria-label="Report link" onFocus={(e) => e.target.select()} />
              <Button icon={Copy} onClick={() => void copy(link.url)}>
                Copy
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-zinc-400">
              <span>Copied to the clipboard. Works until {dateText(link.expiresAt)}.</span>
              <a href={link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline dark:text-brand-400">
                Open <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
          </div>
        )}
        {error && (
          <Notice tone="danger" title="The link could not be created">
            {error}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
