import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { PostLoadForm } from "@/components/PostLoadForm";

/**
 * Posting a job from the website. Posters and admins only.
 *
 * A driver who lands here is not shown a wall -- they are sent back to the
 * board with a one-line notice. Finding out that posting needs a poster account
 * is worth a sentence, not a locked door.
 */
export const dynamic = "force-dynamic";

export default async function PostPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/post"));
  if (user.role === "driver") redirect("/?notice=poster-only");

  return (
    <AppShell user={user} active="post" currentPath="/post">
      <PostLoadForm user={{ name: user.name, phone: user.phone }} />
    </AppShell>
  );
}
