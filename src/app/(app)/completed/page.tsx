import type { Metadata } from "next";
import { DraftList } from "../drafts/draft-list";

export const metadata: Metadata = { title: "Completed" };

export default function CompletedPage() {
  return <DraftList bucket="completed" />;
}
