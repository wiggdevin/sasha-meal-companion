import type { Metadata, Viewport } from "next";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import AppChrome from "@/components/AppChrome";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import ClientErrorHook from "@/components/ClientErrorHook";
import InstallPrompt from "@/components/InstallPrompt";
import SyncBootstrap from "@/components/SyncBootstrap";
import AuthGate from "@/components/AuthGate";
import DevFreshnessBanner from "@/components/DevFreshnessBanner";
import { THEME_COLOR } from "@/lib/design/theme-color";
import { readAppCapabilities } from "@/lib/capabilities";
import SectionHue from "@/components/SectionHue";
import { APP_NAME } from "@/lib/brand";

// Harvest theme type (DESIGN.md §Typography, 2026-10-01): Fraunces for titles, Plus Jakarta Sans for
// the rest. Both are variable fonts; Fraunces also carries its optical-size and softness axes, so a
// 64 px numeral and a 20 px card title each get their own cut. next/font self-hosts both, so the
// browser never calls Google.
const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
  style: ["normal", "italic"],
  variable: "--font-display-face",
  display: "swap",
});
const sans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-text-face",
  display: "swap",
});

export const metadata: Metadata = {
  title: APP_NAME,
  description: "What to eat, and when.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: APP_NAME,
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const capabilities = readAppCapabilities(process.env);

  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body className="bg-paper text-charcoal antialiased">
        <ClientErrorHook />
        <DevFreshnessBanner />
        <CapabilitiesProvider value={capabilities}>
          {/* The Harvest ground (DESIGN.md §Techniques): still, pure CSS, oat with a matte grain. */}
          <div className="harvest-ground" aria-hidden="true" />
          <SectionHue />
          <ServiceWorkerRegistrar />
          <SyncBootstrap />
          <InstallPrompt />
          <AuthGate>
            {children}
            <AppChrome />
          </AuthGate>
        </CapabilitiesProvider>
      </body>
    </html>
  );
}
