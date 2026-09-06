import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

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
  title: "LoadLine — moving backhauls from WhatsApp, on a map",
  description:
    "Backhaul jobs for movers, pulled out of WhatsApp group chats and put on a map: route, cubic feet, price and who to call.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}>{children}</body>
    </html>
  );
}
