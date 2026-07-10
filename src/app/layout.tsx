import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "محرك الشخصيات المتكلمة | Talking Characters Studio",
  description: "حوّل أي صورة لشخصية متكلمة - lip sync + حركة طبيعية",
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
      </head>
      <body className="font-cairo antialiased">{children}</body>
    </html>
  );
}
