"use client";

import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Notice } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { password } });
      window.location.assign(safeNext(params.get("next")));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="surface flex flex-col gap-4 p-6">
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="Password">
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!password}>
        Sign in
      </Button>
    </form>
  );
}
