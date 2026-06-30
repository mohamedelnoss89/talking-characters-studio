import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "محرك الشخصيات المتكلمة | Talking Characters Studio",
  description: "حوّل أي صورة لشخصية متكلمة - lip sync + حركة طبيعية",
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
