import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { dashboardStats } from "@/lib/loads/stats";
import { formatMiles } from "@/lib/geo/math";
import { Chip, StatusChip, formatPickupDate } from "@/components/ui";
import type { LoadRow } from "@/lib/loads/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const viewer =
    user.home_lat != null && user.home_lng != null
      ? { lat: user.home_lat, lng: user.home_lng, label: user.home_label ?? undefined }
      : null;
  const stats = await dashboardStats(viewer);

  return (
    <AppShell user={user} active="dashboard">
      <div className="mx-auto max-w-[1600px] space-y-5 p-5">
        {/* --- the one-line answer the product promises --- */}
        <section className="card p-5" style={{ background: "var(--accent-soft)", borderColor: "#c9d8ff" }}>
          <h1 className="text-[19px] font-bold tracking-tight">
            {stats.totalAvailable} loads on the board right now
          </h1>
          <p className="mt-1 max-w-[70ch] text-[13px] text-muted">
            Pulled out of {stats.pipeline.processedToday + stats.pipeline.skippedToday} WhatsApp
            messages in the last 24 hours, geocoded, de-duplicated and expired automatically.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="btn btn-primary" href="/loads?date=tomorrow&sort=distance">
              Loads tomorrow near me
            </Link>
            <Link
              className="btn"
              href={
                viewer
                  ? `/loads?origin=${encodeURIComponent(user.home_label ?? "")}&dest=Florida&routeMode=corridor&corridor=75&date=week`
                  : "/loads?routeMode=corridor"
              }
            >
              Find loads along a route
            </Link>
            <Link className="btn" href="/loads?date=today">
              Everything today
            </Link>
          </div>
        </section>

        {/* --- counters --- */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Available today" value={stats.availableToday} href="/loads?date=today" />
          <Stat label="Available tomorrow" value={stats.availableTomorrow} href="/loads?date=tomorrow" />
          <Stat label="New in 24h" value={stats.newLast24h} href="/loads?sort=newest" />
          <Stat
            label={viewer ? `Within 100 mi of ${user.home_label}` : "Near me"}
            value={stats.nearMe}
            href="/loads?radius=100&sort=distance&date=week"
          />
          <Stat label="Duplicate clusters caught" value={stats.pipeline.duplicateClusters} />
        </section>

        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5">
            {stats.near.length > 0 && (
              <Panel
                title={`Closest to ${user.home_label ?? "you"}`}
                action={{ href: "/loads?radius=100&sort=distance&date=week", label: "See all" }}
              >
                {stats.near.map((l) => (
                  <Row key={l.id} load={l} showDistance />
                ))}
              </Panel>
            )}

            <Panel title="Just posted" action={{ href: "/loads?sort=newest", label: "See all" }}>
              {stats.recent.map((l) => (
                <Row key={l.id} load={l} />
              ))}
            </Panel>
          </div>

          <div className="space-y-5">
            <Panel title="Most active pickup states">
              {stats.topStates.map((s) => (
                <Link
                  key={s.state}
                  href={`/loads?pickupState=${s.state}`}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2"
                >
                  <span className="w-8 font-bold">{s.state}</span>
                  <span
                    className="h-1.5 flex-1 rounded-full"
                    style={{ background: "var(--surface-2)" }}
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.max((s.count / (stats.topStates[0]?.count || 1)) * 100, 6)}%`,
                        background: "var(--accent)",
                      }}
                    />
                  </span>
                  <span className="nums w-8 text-right text-[13px] font-semibold">{s.count}</span>
                </Link>
              ))}
            </Panel>

            {stats.topLanes.length > 0 && (
              <Panel title="Busiest lanes">
                {stats.topLanes.map((l) => (
                  <div key={l.lane} className="flex items-center justify-between px-3 py-2 text-[13px]">
                    <span>{l.lane}</span>
                    <span className="nums font-semibold">{l.count}</span>
                  </div>
                ))}
              </Panel>
            )}

            {user.role === "admin" && (
              <Panel title="Pipeline" action={{ href: "/admin", label: "Open admin" }}>
                <Line label="Waiting to process" value={stats.pipeline.pending} />
                <Line label="Turned into loads (24h)" value={stats.pipeline.processedToday} />
                <Line label="Skipped as chatter (24h)" value={stats.pipeline.skippedToday} />
                <Line label="Errors" value={stats.pipeline.errors} warn={stats.pipeline.errors > 0} />
                <Line label="Flagged for review" value={stats.needsReview} />
              </Panel>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const inner = (
    <div className="card p-3.5">
      <div className="nums text-[24px] font-bold leading-none">{value}</div>
      <div className="mt-1.5 text-[12px] text-muted">{label}</div>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-shadow hover:shadow-sm">
      {inner}
    </Link>
  ) : (
    inner
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-[13px] font-bold">{title}</h2>
        {action && (
          <Link href={action.href} className="text-[12px] font-semibold" style={{ color: "var(--accent)" }}>
            {action.label}
          </Link>
        )}
      </header>
      <div className="divide-y divide-[color:var(--border)]">{children}</div>
    </section>
  );
}

function Row({ load, showDistance }: { load: LoadRow; showDistance?: boolean }) {
  const date = formatPickupDate(load.pickup_date);
  return (
    <Link href={`/loads?q=${encodeURIComponent(load.pickup_label)}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">
            {load.pickup_label} → {load.delivery_label}
          </span>
          {load.dup_count > 1 && <Chip>{load.dup_count}×</Chip>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2.5 text-[12px] text-muted">
          <span>{date.relative ? `${date.relative}, ${date.text}` : date.text}</span>
          {load.load_type && <span>{load.load_type}</span>}
          {load.contact_name && <span>{load.contact_name}</span>}
        </div>
      </div>
      {showDistance && load.distance_miles != null ? (
        <span className="nums shrink-0 text-[13px] font-bold">{formatMiles(load.distance_miles)}</span>
      ) : (
        <StatusChip status={load.status} />
      )}
    </Link>
  );
}

function Line({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="nums font-semibold" style={warn ? { color: "var(--danger)" } : undefined}>
        {value}
      </span>
    </div>
  );
}
