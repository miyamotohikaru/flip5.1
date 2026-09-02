import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "数式の絶景",
  description: "画像も、3Dモデルも、音のファイルも、1つも使っていない風景。裏返すと、数式。",
  openGraph: {
    title: "数式の絶景",
    description: "画像も、3Dモデルも、音のファイルも、1つも使っていない風景。裏返すと、数式。",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0b1020",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
