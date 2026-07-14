import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "محرك الشخصيات المتكلمة | Talking Characters Studio",
  description: "حوّل أي صورة لشخصية متكلمة - lip sync + حركة طبيعية",
  manifest: "/manifest.json",
  applicationName: "Talking Characters Studio",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Talking Characters",
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: ["/favicon-32.png"],
  },
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
};

// Mobile-friendly viewport — disables user zoom lock (accessible) but sets
// width=device-width so the layout adapts to phone screens instead of
// rendering as a tiny 980px-wide desktop page.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5, // allow zoom for accessibility, but cap it
  themeColor: "#0a0b10",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body className="font-cairo antialiased">{children}</body>
    </html>
  );
}
