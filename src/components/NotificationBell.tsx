import Link from "next/link";
import { ownsListingOrNotification, unreadCount } from "@/lib/notify/query";

/**
 * The bell, and the rule about when there is one.
 *
 * IT IS ABSENT FOR AN ACCOUNT THAT OWNS NOTHING, which is SPEC 2's decision and
 * the only interesting thing about this component. A bell with a permanent zero
 * teaches people to ignore bells, and this board is public: most of the people
 * looking at it have posted nothing and can never be notified about anything.
 * An anonymous visitor does not reach this component at all -- `AppShell`
 * renders it only for a signed-in user -- so the query below never runs for the
 * traffic that makes up most of the board.
 *
 * A SERVER COMPONENT, deliberately, and async. The count is a fact about the
 * database at the moment the page was built, and every page that renders the
 * shell is already dynamic (they all read the session cookie). A client
 * component would mean a fetch on every page load, a spinner in the header, and
 * a number that arrives late on the one screen -- the board -- that is doing
 * MapLibre work at the same moment.
 *
 * SPEC 2, 12.3.
 */
export async function NotificationBell({ userId }: { userId: number }) {
  if (!(await ownsListingOrNotification(userId))) return null;
  const unread = await unreadCount(userId);

  return (
    <Link
      href="/notifications"
      // Same 44 px target as the logo and the More menu, and the same square
      // shape from `md` up where the header stops being thumb-sized.
      className="tap relative flex h-[var(--tap-min)] w-[var(--tap-min)] shrink-0 items-center justify-center rounded-md md:h-[var(--control-h)] md:w-[var(--control-h)]"
      style={{ color: unread > 0 ? "var(--accent-deep)" : "var(--text-2)" }}
      aria-label={
        unread > 0
          ? `Notifications, ${unread} unread`
          : "Notifications"
      }
      title="Loads that match your trucks, and trucks that could take your jobs"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path
          d="M9 2a4.5 4.5 0 0 0-4.5 4.5c0 2.6-.7 4-1.2 4.7a.6.6 0 0 0 .5.95h10.4a.6.6 0 0 0 .5-.95c-.5-.7-1.2-2.1-1.2-4.7A4.5 4.5 0 0 0 9 2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M7.2 14.3a1.9 1.9 0 0 0 3.6 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      {unread > 0 ? (
        // The number, not a dot: "3 waiting" and "one waiting" are different
        // reasons to stop what you are doing. Capped at 9+ because the badge is
        // 16 px and a three-digit count would push it under the location pill.
        <span
          className="absolute -right-0.5 -top-0.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-[var(--radius-pill)] px-[3px] text-(length:--fs-xs) font-semibold leading-none md:right-0 md:top-0"
          style={{ background: "var(--accent)", color: "#fff" }}
        >
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
