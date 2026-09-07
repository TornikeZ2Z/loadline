import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { loginHref } from "@/lib/session";
import { AppShell } from "@/components/AppShell";
import { PostTruckForm } from "@/components/PostTruckForm";

/**
 * Posting available truck space. Any signed-in account, and that is the point.
 *
 * The gate is `canPost`, the same capability a job needs -- NOT the `poster`
 * role. A driver who registered as a driver must be able to post their own
 * empty leg, or the feature is unreachable by the people it is for. That was
 * open question 2 in the specification (§20) and this is where it is answered:
 * the registration copy on `AuthForm` now says the two words describe which
 * door you came in through, not what you may do.
 *
 * A demo account reaches the same form and the same 201, and `isDemo` travels
 * down so the form can say what that means. The gate is in the data
 * (`trucks.is_demo`, and `demoVisibilitySql` in truckQuery.ts); this is only
 * the part that tells the truth about it.
 */
export const dynamic = "force-dynamic";

export default async function PostTruckPage() {
  const user = await getCurrentUser();
  if (!user) redirect(loginHref("/post/truck"));
  if (!user.canPost) redirect("/?notice=poster-only");

  return (
    <AppShell user={user} active="post" currentPath="/post/truck">
      <PostTruckForm user={{ name: user.name, phone: user.phone, isDemo: user.isDemo }} />
    </AppShell>
  );
}
