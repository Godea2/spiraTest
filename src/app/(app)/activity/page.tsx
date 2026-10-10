import type { Metadata } from "next";
import { ActivityLog } from "./activity-log";

export const metadata: Metadata = { title: "Activity" };

export default function ActivityPage() {
  return <ActivityLog />;
}
