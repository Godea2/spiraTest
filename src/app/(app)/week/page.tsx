import type { Metadata } from "next";
import { WeekWorkspace } from "./week-workspace";

export const metadata: Metadata = { title: "Week" };

export default function WeekPage() {
  return <WeekWorkspace />;
}
