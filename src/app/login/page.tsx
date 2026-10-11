import { GitCompareArrows, Layers3, ShieldCheck, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { Logo } from "@/components/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const POINTS = [
  { icon: GitCompareArrows, title: "Compare scope with Spira", text: "Match the release workbook against every test set in a module." },
  { icon: Sparkles, title: "Spot what is not built yet", text: "Keywords and an AI review flag cases blocked by missing features." },
  { icon: ShieldCheck, title: "Apply safely", text: "Membership checks, typed confirmation and undo before anything changes." },
];

export default function LoginPage() {
  return (
    <main className="app-backdrop grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden border-r border-slate-200/70 bg-gradient-to-br from-brand-600 via-violet-600 to-fuchsia-600 p-12 text-white lg:flex lg:flex-col dark:border-white/[0.06]">
        <div className="pointer-events-none absolute -top-40 -right-40 size-[32rem] rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-48 -left-24 size-[28rem] rounded-full bg-fuchsia-300/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-white/15 ring-1 ring-white/25 backdrop-blur">
            <Layers3 className="size-5" aria-hidden />
          </span>
          <span className="font-semibold tracking-tight">Test Set Reconciler</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <h2 className="text-4xl leading-tight font-semibold tracking-tight text-balance">Release sign-off, without the spreadsheet juggling.</h2>
          <ul className="mt-10 flex flex-col gap-6">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/15 ring-1 ring-white/20">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span>
                  <span className="block font-medium">{title}</span>
                  <span className="mt-0.5 block text-sm text-white/75">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="grid place-items-center px-4 py-12">
        <div className="w-full max-w-sm animate-fade-up">
          <div className="mb-8 flex flex-col items-center text-center lg:items-start lg:text-left">
            <Logo size="lg" />
            <h1 className="mt-6 text-2xl font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-1.5 text-sm text-slate-600 dark:text-zinc-400">Sign in with the team password to continue.</p>
          </div>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </main>
  );
}
