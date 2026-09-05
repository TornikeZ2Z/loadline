import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { LogoutButton } from "./LogoutButton";
import { CurrentLocation } from "./CurrentLocation";

export function AppShell({
  user,
  active,
  children,
}: {
  user: SessionUser;
  active: "dashboard" | "loads" | "post" | "admin" | "test";
  children: React.ReactNode;
}) {
  const nav: Array<{ key: typeof active; href: string; label: string; show: boolean }> = [
    { key: "dashboard", href: "/", label: "Dashboard", show: true },
    { key: "loads", href: "/loads", label: "Find loads", show: true },
    { key: "post", href: "/post", label: "Post a load", show: user.role !== "carrier" },
    { key: "test", href: "/test", label: "WhatsApp test", show: true },
    { key: "admin", href: "/admin", label: "Admin", show: user.role === "admin" },
  ];

  return (
    <div className="min-h-screen">
      <header className="bg-surface border-b border-border sticky top-0 z-30">
        <div className="mx-auto flex max-w-[1600px] items-center gap-6 px-5 py-2.5">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[13px] text-white"
              style={{ background: "var(--accent)" }}
            >
              L
            </span>
            LoadLine
          </Link>

          <nav className="flex items-center gap-1">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className="rounded-md px-3 py-1.5 text-[13px] font-semibold"
                  style={
                    active === n.key
                      ? { background: "var(--accent-soft)", color: "var(--accent)" }
                      : { color: "var(--muted)" }
                  }
                >
                  {n.label}
                </Link>
              ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight">
              <div className="text-[13px] font-semibold">{user.name}</div>
              <CurrentLocation label={user.home_label} role={user.role} />
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
