import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import AppChrome from "@/components/AppChrome";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import ClientErrorHook from "@/components/ClientErrorHook";
import ZodJitless from "@/components/ZodJitless";
import InstallPromptCapture from "@/components/InstallPromptCapture";
import SyncBootstrap from "@/components/SyncBootstrap";
import AuthGate from "@/components/AuthGate";
import DevFreshnessBanner from "@/components/DevFreshnessBanner";
import { NONCE_HEADER } from "@/lib/security-headers";
import { GROUND_BOOT_SCRIPT } from "@/lib/design/ground-boot";
import GroundTheme from "@/components/GroundTheme";
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
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: THEME_COLOR,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Reading the request makes every page render per request (W079): Next stamps its own scripts
  // with the request's CSP nonce (middleware.ts) only while rendering, so a page prerendered at
  // build time would carry none. The one inline script of our own takes the same nonce.
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  const capabilities = readAppCapabilities(process.env);

  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${sans.variable}`}>
      <body className="bg-paper text-charcoal antialiased">
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: GROUND_BOOT_SCRIPT }} />
        <ZodJitless />
        <ClientErrorHook />
        <DevFreshnessBanner />
        <CapabilitiesProvider value={capabilities}>
          {/* The Harvest ground (DESIGN.md §Techniques): still, pure CSS, oat with a matte grain. */}
          <div className="harvest-ground" aria-hidden="true" />
          <SectionHue />
          <GroundTheme />
          <ServiceWorkerRegistrar />
          <SyncBootstrap />
          {/* The visible install card is inline on the Today page (owner feedback, 2026-10-08: it
              must never float over a meal card's actions). Only the silent capture — attaching
              `beforeinstallprompt` before it can be missed — lives at the root. */}
          <InstallPromptCapture />
          <AuthGate>
            {children}
            <AppChrome />
          </AuthGate>
        </CapabilitiesProvider>
      </body>
    </html>
  );
}
