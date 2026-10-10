"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "@/lib/client/api";
import { useSettings } from "./settings-context";

const NAV = [
  { href: "/", label: "Compare", match: (p: string) => p === "/" },
  { href: "/drafts", label: "Drafts", match: (p: string) => p.startsWith("/drafts") },
  { href: "/activity", label: "Activity", match: (p: string) => p.startsWith("/activity") },
  { href: "/settings", label: "Settings", match: (p: string) => p.startsWith("/settings") },
];

function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function ThemeToggle() {
  const dark = useSyncExternalStore(
    subscribeToTheme,
    () => document.documentElement.classList.contains("dark"),
    () => null,
  );
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      {dark ? (
        <svg viewBox="0 0 20 20" fill="currentColor" className="size-5" aria-hidden>
          <path d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15Zm0-9a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-8 4a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 2 10Zm13 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 15 10Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="currentColor" className="size-5" aria-hidden>
          <path d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z" />
        </svg>
      )}
    </button>
  );
}

function ModePill() {
  const { settings } = useSettings();
  if (!settings) return null;
  return settings.mockMode ? (
    <Link
      href="/settings"
      className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200"
      title="Using simulated Spira data. Change in Settings."
    >
      Mock mode
    </Link>
  ) : (
    <Link
      href="/settings"
      className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200"
      title="Connected to n8n and Spira. Change in Settings."
    >
      Live · Project {settings.projectId}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-brand-600 text-sm text-white">S</span>
            <span className="hidden sm:inline">Test Set Reconciler</span>
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.match(pathname) ? "page" : undefined}
                className={clsx(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  item.match(pathname)
                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white"
                    : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <ModePill />
            <ThemeToggle />
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              className="rounded-lg px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              Sign out
            </button>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto border-t border-zinc-100 px-3 py-1.5 md:hidden dark:border-zinc-800">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.match(pathname) ? "page" : undefined}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap",
                item.match(pathname)
                  ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white"
                  : "text-zinc-600 dark:text-zinc-400",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
