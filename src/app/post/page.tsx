import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { PostLoadForm } from "@/components/PostLoadForm";

/**
 * Posting a job from the website. Any signed-in account.
 *
 * This used to bounce the `driver` role, which is what made a company that both
 * hauls and posts open two accounts. Posting is a capability now
 * (`users.can_post`, on by default), so the redirect only fires for an account
 * an admin has switched it off for -- and even then it is a sentence on the
 * board, not a locked door.
 *
 * A demo account reaches the same form and the same 201. `isDemo` travels down
 * so the page can SAY what that means -- a demo listing is visible to this
 * account and nobody else -- rather than let the poster believe they published
 * to the board. The gate is in the data (`loads.is_demo`); this is only the
 * part that tells the truth about it.
 */
export const dynamic = "force-dynamic";

export default async function PostPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/post"));
  if (!user.canPost) redirect("/?notice=poster-only");

  return (
    <AppShell user={user} active="post" currentPath="/post">
      <PostLoadForm user={{ name: user.name, phone: user.phone, isDemo: user.isDemo }} />
    </AppShell>
  );
}
