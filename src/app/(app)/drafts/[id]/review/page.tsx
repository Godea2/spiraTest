import type { Metadata } from "next";
import { Review } from "./review";

export const metadata: Metadata = { title: "Review and apply" };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Review id={id} />;
}
