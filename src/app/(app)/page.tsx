import { redirect } from "next/navigation";

/** Home lands on the build execute workspace; Compare stays at /compare. */
export default function HomePage() {
  redirect("/uat-build");
}
