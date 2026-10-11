"use client";

import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ChevronDown, Info, XCircle, type LucideIcon } from "lucide-react";
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
    "bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(15_23_42/0.2)] hover:from-brand-500 hover:to-brand-700 hover:shadow-glow disabled:from-brand-500/60 disabled:to-brand-600/60 disabled:shadow-none",
  secondary:
    "border border-slate-200 bg-white text-slate-800 shadow-xs hover:border-slate-300 hover:bg-slate-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-100 dark:hover:bg-white/[0.08]",
  ghost: "text-slate-600 hover:bg-slate-900/[0.05] hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white",
  ghostDanger: "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10",
  danger:
    "bg-gradient-to-b from-red-500 to-red-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_1px_2px_rgb(15_23_42/0.2)] hover:to-red-700 disabled:opacity-60",
};

const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-xs",
  md: "h-10 gap-2 rounded-xl px-4 text-sm",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra?: string) {
  return clsx(
    "inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
    extra,
  );
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; busy?: boolean; icon?: LucideIcon }
>(function Button({ variant = "secondary", size = "md", busy, icon: Icon, className, children, disabled, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={buttonClass(variant, size, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <Spinner className="size-3.5" /> : Icon ? <Icon aria-hidden /> : null}
      {children}
    </button>
  );
});

export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon: Icon,
  className,
  children,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size; icon?: LucideIcon }) {
  return (
    <Link className={buttonClass(variant, size, className)} {...props}>
      {Icon && <Icon aria-hidden />}
      {children}
    </Link>
  );
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
  neutral: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10",
  brand: "bg-brand-50 text-brand-700 ring-brand-200/70 dark:bg-brand-500/10 dark:text-brand-200 dark:ring-brand-400/20",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200/70 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  warning: "bg-amber-50 text-amber-800 ring-amber-200/70 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
  danger: "bg-red-50 text-red-700 ring-red-200/70 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset [&_svg]:size-3", badgeTones[tone], className)}>
      {children}
    </span>
  );
}

const noticeTones = {
  info: {
    box: "border-brand-200/70 bg-brand-50/70 text-brand-950 dark:border-brand-400/20 dark:bg-brand-500/[0.07] dark:text-brand-100",
    icon: Info,
    iconClass: "text-brand-600 dark:text-brand-300",
  },
  success: {
    box: "border-emerald-200/70 bg-emerald-50/70 text-emerald-950 dark:border-emerald-400/20 dark:bg-emerald-500/[0.07] dark:text-emerald-100",
    icon: CheckCircle2,
    iconClass: "text-emerald-600 dark:text-emerald-300",
  },
  warning: {
    box: "border-amber-200/80 bg-amber-50/80 text-amber-950 dark:border-amber-400/20 dark:bg-amber-500/[0.07] dark:text-amber-100",
    icon: AlertTriangle,
    iconClass: "text-amber-600 dark:text-amber-300",
  },
  danger: {
    box: "border-red-200/80 bg-red-50/80 text-red-950 dark:border-red-400/20 dark:bg-red-500/[0.08] dark:text-red-100",
    icon: XCircle,
    iconClass: "text-red-600 dark:text-red-300",
  },
} as const;

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
  const style = noticeTones[tone];
  const Icon = style.icon;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={clsx("flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-start", style.box, className)}
    >
      <div className="flex min-w-0 flex-1 gap-3">
        <Icon className={clsx("mt-0.5 size-4 shrink-0", style.iconClass)} aria-hidden />
        <div className="min-w-0 flex-1">
          {title && <p className="font-semibold">{title}</p>}
          {children && <div className={clsx(title && "mt-0.5", "opacity-90")}>{children}</div>}
        </div>
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
    <header className="flex animate-fade-up flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-zinc-400">{eyebrow}</div>}
        <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[0.9375rem] leading-relaxed text-slate-600 dark:text-zinc-400">{description}</p>}
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
  icon: Icon,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  icon?: LucideIcon;
}) {
  return (
    <section className={clsx("surface p-5 sm:p-6", className)}>
      {(title || actions) && (
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            {Icon && (
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-400/20">
                <Icon className="size-[18px]" aria-hidden />
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold tracking-tight">{title}</h2>}
              {description && <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-zinc-400">{description}</p>}
            </div>
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
      <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-zinc-200">
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500 dark:text-zinc-400">
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
        {description && <p className="mt-0.5 text-sm text-slate-600 dark:text-zinc-400">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors",
          checked ? "bg-brand-600" : "bg-slate-300 dark:bg-zinc-700",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200",
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
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-white/[0.08]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div
        className={clsx(
          "h-full rounded-full transition-[width] duration-500 ease-out",
          tone === "danger" ? "bg-red-500" : tone === "success" ? "bg-emerald-500" : "bg-gradient-to-r from-brand-500 via-violet-500 to-fuchsia-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon: Icon,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="surface flex animate-fade-up flex-col items-center px-6 py-16 text-center">
      {Icon && (
        <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-50 to-violet-50 text-brand-600 ring-1 ring-brand-100 dark:from-brand-500/15 dark:to-violet-500/10 dark:text-brand-300 dark:ring-brand-400/20">
          <Icon className="size-6" aria-hidden />
        </span>
      )}
      <p className="text-base font-semibold">{title}</p>
      {children && <p className="mt-1.5 max-w-md text-sm leading-relaxed text-slate-600 dark:text-zinc-400">{children}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
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
      className={clsx(
        "m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-lift dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100",
        wide ? "max-w-4xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div className="overflow-y-auto p-6">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            <div className="mt-3 text-sm leading-relaxed text-slate-700 dark:text-zinc-300">{children}</div>
          </div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-6 py-4 dark:border-white/[0.06] dark:bg-white/[0.02]">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

export function Collapsible({
  title,
  count,
  icon: Icon,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  count?: number;
  icon?: LucideIcon;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="surface overflow-hidden">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50/60 dark:hover:bg-white/[0.02]"
        aria-expanded={open}
        onClick={onToggle}
      >
        {Icon && <Icon className="size-4 text-slate-500 dark:text-zinc-400" aria-hidden />}
        <span className="font-semibold tracking-tight">{title}</span>
        {count !== undefined && <Badge>{count}</Badge>}
        <ChevronDown className={clsx("ml-auto size-4 text-slate-400 transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      {open && <div className="animate-fade-up border-t border-slate-100 pt-2 dark:border-white/[0.06]">{children}</div>}
    </section>
  );
}

const statTones = {
  danger: { value: "text-red-600 dark:text-red-400", icon: "bg-red-50 text-red-600 ring-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20" },
  warning: { value: "text-amber-600 dark:text-amber-400", icon: "bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20" },
  success: { value: "text-emerald-600 dark:text-emerald-400", icon: "bg-emerald-50 text-emerald-600 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20" },
  orange: { value: "text-orange-600 dark:text-orange-400", icon: "bg-orange-50 text-orange-600 ring-orange-100 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/20" },
  neutral: { value: "", icon: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-white/[0.06] dark:text-zinc-300 dark:ring-white/10" },
} as const;

export function Stat({
  label,
  value,
  tone,
  icon: Icon,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof statTones;
  icon?: LucideIcon;
  hint?: ReactNode;
}) {
  const style = statTones[tone ?? "neutral"];
  return (
    <div className="flex min-w-0 items-start gap-3">
      {Icon && (
        <span className={clsx("grid size-9 shrink-0 place-items-center rounded-xl ring-1", style.icon)}>
          <Icon className="size-[18px]" aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <dt className="truncate text-xs font-medium text-slate-500 dark:text-zinc-400">{label}</dt>
        <dd className={clsx("mt-0.5 text-2xl leading-none font-semibold tracking-tight tabular-nums", style.value)}>{value}</dd>
        {hint && <dd className="mt-1 truncate text-xs text-slate-500 dark:text-zinc-500">{hint}</dd>}
      </div>
    </div>
  );
}
