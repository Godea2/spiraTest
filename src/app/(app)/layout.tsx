import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SettingsProvider } from "@/components/settings-context";
import { StoreGate } from "@/components/store-gate";
import { hasSession } from "@/lib/server/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await hasSession())) redirect("/login");
  return (
    <StoreGate>
      <SettingsProvider>
        <AppShell>{children}</AppShell>
      </SettingsProvider>
    </StoreGate>
  );
}
