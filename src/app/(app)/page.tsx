import { redirect } from "next/navigation";

/** Home lands on SIT build; UAT build is a separate nav item. */
export default function HomePage() {
  redirect("/sit-build");
}
