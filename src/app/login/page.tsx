import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-brand-600 text-lg font-semibold text-white">S</span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">Spira Test Set Reconciler</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Sign in with the team password to continue.</p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
