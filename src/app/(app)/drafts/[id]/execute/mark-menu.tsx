"use client";

import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui";
import { STATUS_LABEL } from "@/lib/domain/execution";
import { EXECUTION_STATUSES, type ExecutionStatus } from "@/lib/domain/types";
import { STATUS_STYLE } from "./runner";

const HINT: Record<ExecutionStatus, string> = {
  passed: "Every step Passed",
  failed: "Asks for what went wrong",
  blocked: "Asks why it is blocked",
  caution: "Asks for the concern",
};

const DOT: Record<ExecutionStatus, string> = {
  passed: "bg-emerald-500",
  failed: "bg-red-500",
  blocked: "bg-orange-500",
  caution: "bg-amber-500",
};

/** "Mark N as" with a menu of results. Keys P, F, B and C pick a result while the menu is open. */
export function MarkMenu({ count, busy, onPick }: { count: number; busy: boolean; onPick: (status: ExecutionStatus) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) items.current[active]?.focus();
  }, [open, active]);

  const pick = (status: ExecutionStatus) => {
    setOpen(false);
    onPick(status);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    const byKey = EXECUTION_STATUSES.find((s) => STATUS_STYLE[s].key.toLowerCase() === e.key.toLowerCase());
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + EXECUTION_STATUSES.length) % EXECUTION_STATUSES.length);
    } else if (byKey) {
      e.preventDefault();
      pick(byKey);
    }
  };

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        busy={busy}
        disabled={busy}
        onClick={() => {
          setActive(0);
          setOpen((o) => !o);
        }}
      >
        Mark {count} as
        <ChevronDown className={clsx("size-4 transition-transform", open && "rotate-180")} aria-hidden />
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`Mark ${count} as`}
          className="absolute top-full left-0 z-20 mt-1.5 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white p-1 shadow-lift dark:border-white/10 dark:bg-zinc-900"
        >
          {EXECUTION_STATUSES.map((status, i) => (
            <button
              key={status}
              ref={(el) => {
                items.current[i] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={i === active ? 0 : -1}
              onClick={() => pick(status)}
              onMouseEnter={() => setActive(i)}
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none focus:bg-slate-100 dark:focus:bg-white/[0.06]"
            >
              <span className={clsx("size-2.5 shrink-0 rounded-full", DOT[status])} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{STATUS_LABEL[status]}</span>
                <span className="block text-xs text-slate-500 dark:text-zinc-400">{HINT[status]}</span>
              </span>
              <kbd className="kbd">{STATUS_STYLE[status].key}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
