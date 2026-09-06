import type { Metadata, Viewport } from "next";
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

/**
 * `width=device-width, initial-scale=1` is Next's default and is restated only
 * so the third value has somewhere to live.
 *
 * `interactiveWidget: "resizes-content"` is the one that matters on a phone.
 * By default the on-screen keyboard resizes only the VISUAL viewport, which
 * leaves `position: fixed` where it was — under the keyboard. Two of this app's
 * forms live in a fixed panel: the sign-in step inside the board's bottom sheet
 * (the one place a phone number is ever asked for) and the search box in the
 * full-screen filter sheet. Without this, tapping either one hides the field
 * you are typing into behind the keyboard, with no way to scroll it back.
 * Resizing the layout viewport instead lifts the whole sheet above the keyboard.
 *
 * `viewportFit` is deliberately left alone: `cover` would extend the page under
 * a notch and home indicator, and everything bottom-anchored here would then
 * need safe-area padding that cannot be verified on this hardware.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
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
