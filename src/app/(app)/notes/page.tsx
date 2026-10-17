import type { Metadata } from "next";
import { NotesWorkspace } from "./notes-workspace";

export const metadata: Metadata = { title: "Notes" };

export default function NotesPage() {
  return <NotesWorkspace />;
}
