import { redirect } from "next/navigation";

/** Week was renamed to UAT build. */
export default function WeekRedirectPage() {
  redirect("/uat-build");
}
