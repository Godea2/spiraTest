import type { Metadata } from "next";
import { DraftList } from "./draft-list";

export const metadata: Metadata = { title: "Drafts" };

export default function DraftsPage() {
  return <DraftList />;
}
