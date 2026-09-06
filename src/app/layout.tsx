import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { CookieNotice } from "@/components/CookieNotice";

/**
 * One typeface, loaded through next/font so it is self-hosted and never blocks
 * on a third-party request. The variable is what globals.css reads; every
 * component inherits it from <body>.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  // Every page sets its own title through this template, so a tab in a row of
  // tabs says which LoadLine page it is.
  title: {
    default: "LoadLine — moving backhauls from WhatsApp, on a map",
    template: "%s · LoadLine",
  },
  description:
    "Backhaul jobs for movers, pulled out of WhatsApp group chats and put on a map: route, cubic feet, price and who to call.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}>
        {children}
        {/* Site-wide rather than in AppShell: /login and /register render
            without the shell, and the notice has to be honest everywhere. It is
            fixed-position, so it adds no height to any page -- which is what
            keeps it off the board's map viewport. */}
        <CookieNotice />
      </body>
    </html>
  );
}
