"use client";

import clsx from "clsx";
import {
  Activity,
  GitCompareArrows,
  KanbanSquare,
  LogOut,
  Menu,
  Moon,
  Settings2,
  Sparkles,
  Sun,
  Unplug,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Toaster } from "sonner";
import { api } from "@/lib/client/api";
import { Logo } from "./brand";
import { useSettings } from "./settings-context";

const NAV: Array<{ href: string; label: string; icon: LucideIcon; match: (p: string) => boolean }> = [
  { href: "/", label: "Compare", icon: GitCompareArrows, match: (p) => p === "/" },
  { href: "/drafts", label: "Drafts", icon: KanbanSquare, match: (p) => p.startsWith("/drafts") },
  { href: "/activity", label: "Activity", icon: Activity, match: (p) => p.startsWith("/activity") },
  { href: "/settings", label: "Settings", icon: Settings2, match: (p) => p.startsWith("/settings") },
];

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function useDarkTheme(): boolean | null {
  return useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.classList.contains("dark"),
    () => null,
  );
}

function ThemeToggle({ compact }: { compact?: boolean }) {
  const dark = useDarkTheme();
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };
  const Icon = dark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      className={clsx(
        "flex cursor-pointer items-center gap-2.5 rounded-lg text-sm text-slate-600 transition hover:bg-slate-900/[0.05] hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white",
        compact ? "p-2" : "w-full px-3 py-2",
      )}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      <Icon className="size-4" aria-hidden />
      {!compact && <span>{dark ? "Light theme" : "Dark theme"}</span>}
    </button>
  );
}

function StatusRow({
  href,
  icon: Icon,
  label,
  detail,
  tone,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  detail: string;
  tone: "ok" | "warn" | "off";
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.04]"
      title={`${label}: ${detail}`}
    >
      <span className="relative">
        <Icon className="size-4 text-slate-500 dark:text-zinc-400" aria-hidden />
        <span
          className={clsx(
            "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-white dark:ring-[#0b0c11]",
            tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-slate-400 dark:bg-zinc-600",
          )}
        />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block text-xs font-medium text-slate-700 dark:text-zinc-200">{label}</span>
        <span className="block truncate text-[11px] text-slate-500 dark:text-zinc-500">{detail}</span>
      </span>
    </Link>
  );
}

function ConnectionStatus() {
  const { settings, spira, ai } = useSettings();
  return (
    <div className="flex flex-col gap-0.5">
      {spira && settings ? (
        <StatusRow
          href="/settings"
          icon={spira.configured ? Waypoints : Unplug}
          label="Spira"
          detail={spira.configured ? (settings.projectId === null ? "Choose a project" : `Project ${settings.projectId} · ${spira.host}`) : "Not connected"}
          tone={spira.configured ? (settings.projectId === null ? "warn" : "ok") : "warn"}
        />
      ) : (
        <div className="skeleton mx-3 my-2 h-8" />
      )}
      {ai ? (
        <StatusRow href="/settings" icon={Sparkles} label="AI review" detail={ai.configured ? `Gemini · ${ai.model}` : "Off · add GEMINI_API_KEY"} tone={ai.configured ? "ok" : "off"} />
      ) : (
        <div className="skeleton mx-3 my-2 h-8" />
      )}
    </div>
  );
}

function NavLinks({ pathname, onNavigate, layoutId }: { pathname: string; onNavigate?: () => void; layoutId: string }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map((item) => {
        const active = item.match(pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active ? "text-slate-900 dark:text-white" : "text-slate-600 hover:bg-slate-900/[0.04] hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-white",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-lg bg-white shadow-soft ring-1 ring-slate-200/80 dark:bg-white/[0.07] dark:shadow-none dark:ring-white/10"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <Icon className={clsx("relative size-[18px]", active && "text-brand-600 dark:text-brand-300")} aria-hidden />
            <span className="relative">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function SignOutButton({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const signOut = async () => {
    setSigningOut(true);
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  };
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={signingOut}
      className={clsx(
        "flex cursor-pointer items-center gap-2.5 rounded-lg text-sm text-slate-600 transition hover:bg-slate-900/[0.05] hover:text-slate-900 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-white",
        compact ? "p-2" : "w-full px-3 py-2",
      )}
      aria-label="Sign out"
    >
      <LogOut className="size-4" aria-hidden />
      {!compact && <span>Sign out</span>}
    </button>
  );
}

function SidebarContent({ pathname, onNavigate, layoutId }: { pathname: string; onNavigate?: () => void; layoutId: string }) {
  return (
    <div className="flex h-full flex-col gap-6 px-3 py-5">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-3 px-2">
        <Logo />
        <span className="leading-tight">
          <span className="block text-sm font-semibold tracking-tight">Test Set Reconciler</span>
          <span className="block text-[11px] text-slate-500 dark:text-zinc-500">for SpiraTest</span>
        </span>
      </Link>
      <NavLinks pathname={pathname} onNavigate={onNavigate} layoutId={layoutId} />
      <div className="mt-auto flex flex-col gap-3">
        <div className="well py-1.5">
          <ConnectionStatus />
        </div>
        <div className="flex flex-col gap-0.5">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const dark = useDarkTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="app-backdrop min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200/70 bg-white/60 backdrop-blur-xl lg:block dark:border-white/[0.06] dark:bg-[#0b0c11]/70">
        <SidebarContent pathname={pathname} layoutId="nav-desktop" />
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200/70 bg-white/75 px-4 backdrop-blur-xl lg:hidden dark:border-white/[0.06] dark:bg-[#07080c]/75">
        <button
          type="button"
          className="-ml-1 cursor-pointer rounded-lg p-2 text-slate-600 hover:bg-slate-900/[0.05] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Logo />
          <span className="text-sm">Test Set Reconciler</span>
        </Link>
        <div className="ml-auto flex items-center">
          <ThemeToggle compact />
        </div>
      </header>

      <AnimatePresence>
        {menuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <motion.div
              className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMenuOpen(false)}
            />
            <motion.aside
              className="absolute inset-y-0 left-0 w-72 border-r border-slate-200 bg-white shadow-lift dark:border-white/10 dark:bg-[#0b0c11]"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 420, damping: 40 }}
            >
              <button
                type="button"
                className="absolute top-4 right-3 cursor-pointer rounded-lg p-2 text-slate-500 hover:bg-slate-900/[0.05] dark:text-zinc-400 dark:hover:bg-white/[0.06]"
                onClick={() => setMenuOpen(false)}
                aria-label="Close menu"
              >
                <X className="size-5" aria-hidden />
              </button>
              <SidebarContent pathname={pathname} onNavigate={() => setMenuOpen(false)} layoutId="nav-mobile" />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <main className="lg:pl-64">
        <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
          {children}
        </div>
      </main>

      <Toaster theme={dark ? "dark" : "light"} position="bottom-right" richColors closeButton toastOptions={{ className: "font-sans" }} />
    </div>
  );
}
