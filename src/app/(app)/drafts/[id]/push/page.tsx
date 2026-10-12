import type { Metadata } from "next";
import { Push } from "./push";

export const metadata: Metadata = { title: "Push to the other platform" };

export default async function PushPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Push id={id} />;
}
