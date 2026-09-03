import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { PostLoadForm } from "@/components/PostLoadForm";

export const dynamic = "force-dynamic";

export default async function PostPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "carrier") redirect("/loads");
  return (
    <AppShell user={user} active="post">
      <PostLoadForm />
    </AppShell>
  );
}
