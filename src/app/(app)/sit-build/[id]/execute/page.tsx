"use client";

import { Execute } from "@/app/(app)/drafts/[id]/execute/execute";
import { use } from "react";

export default function SitExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Execute id={id} backHref="/sit-build" backLabel="SIT build" hideBoard />;
}
