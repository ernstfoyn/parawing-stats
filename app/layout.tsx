import type { Metadata, Viewport } from "next";
// Self-hosted, SIL-OFL licensed fonts (no third-party request at runtime).
import "@fontsource/open-sauce-two/300.css";
import "@fontsource/open-sauce-two/400.css";
import "@fontsource/open-sauce-two/600.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parawing stats",
  description:
    "Privacy-first parawing and wingfoil session analysis: GPS tracks, wind, upwind VMG, and every downwind run.",
  applicationName: "Parawing stats",
};

export const viewport: Viewport = {
  themeColor: "#efece5",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
