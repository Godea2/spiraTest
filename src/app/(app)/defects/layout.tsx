import type { Metadata } from "next";

export const metadata: Metadata = { title: "Defects" };

export default function DefectsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
