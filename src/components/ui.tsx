"use client";

import clsx from "clsx";
import Link from "next/link";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from "react";

type Variant = "primary" | "secondary" | "ghost" | "ghostDanger" | "danger";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-white shadow-xs hover:bg-brand-700 disabled:bg-brand-600/50 dark:disabled:bg-brand-600/40",
  secondary:
    "border border-zinc-300 bg-white text-zinc-800 shadow-xs hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
  ghost: "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  ghostDanger: "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40",
  danger: "bg-red-600 text-white shadow-xs hover:bg-red-700 disabled:bg-red-600/50",
};

const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-xs",
  md: "h-10 gap-2 px-4 text-sm",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra?: string) {
  return clsx(
    "inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    variants[variant],
    sizes[size],
    extra,
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean }
>(function Button({ variant = "secondary", size = "md", busy, className, children, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={buttonClass(variant, size, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
});

export function ButtonLink({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx("animate-spin", className ?? "size-4")} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

type Tone = "neutral" | "brand" | "success" | "warning" | "danger";

const badgeTones: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium", badgeTones[tone], className)}>
      {children}
    </span>
  );
}

const noticeTones: Record<Exclude<Tone, "neutral" | "brand"> | "info", string> = {
  info: "border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-100",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
  warning: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
  danger: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100",
};

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof noticeTones;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={clsx("flex flex-col gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row sm:items-start", noticeTones[tone], className)}
    >
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && "mt-0.5", "opacity-90")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-sm text-zinc-500 dark:text-zinc-400">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
  actions,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("surface p-5 sm:p-6", className)}>
      {(title || actions) && (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition-colors",
          checked ? "bg-brand-600" : "bg-zinc-300 dark:bg-zinc-700",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}

export function ProgressBar({ value, max, tone = "brand" }: { value: number; max: number; tone?: "brand" | "danger" | "success" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div
        className={clsx(
          "h-full rounded-full transition-[width]",
          tone === "danger" ? "bg-red-500" : tone === "success" ? "bg-emerald-500" : "bg-brand-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="surface flex flex-col items-center px-6 py-14 text-center">
      <p className="text-base font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm text-zinc-600 dark:text-zinc-400">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {open && (
        <div className="p-6">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <div className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" | "warning" | "success" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd
        className={clsx(
          "mt-0.5 text-xl font-semibold tabular-nums",
          tone === "danger" && "text-red-600 dark:text-red-400",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
          tone === "success" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
