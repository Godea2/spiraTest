import type { Metadata } from "next";
import { Execute } from "./execute";

export const metadata: Metadata = { title: "Execute" };

export default async function ExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Execute id={id} />;
}
