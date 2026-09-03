import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LoadLine — WhatsApp freight, made searchable",
  description:
    "Turns unstructured WhatsApp load posts into a searchable, geographic freight marketplace.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
