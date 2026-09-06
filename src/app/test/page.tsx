import { redirect } from "next/navigation";

/** The console moved behind the admin gate. Old links still land on it. */
export default function TestPage() {
  redirect("/admin/test");
}
