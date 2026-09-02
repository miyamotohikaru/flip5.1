import type { Metadata, Viewport } from "next";
import "./globals.css";

const TITLE = "数式の絶景";
const DESCRIPTION = "画像 0 枚、3Dモデル 0 個、音源 0 個。全部、数式でできた風景。裏返すと、確かめられます。制作: こす.くま × Claude Fable 5.1";
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "https://flip5.1.vercel.app");

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: `%s ｜ ${TITLE}` },
  description: DESCRIPTION,
  applicationName: "MATHSCAPE",
  authors: [{ name: "こす.くま", url: "https://kosukuma.com/" }],
  openGraph: {
    title: `${TITLE} ｜ MATHSCAPE`,
    description: DESCRIPTION,
    type: "website",
    siteName: "こす.くま ／ ふりっぷ",
    locale: "ja_JP",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} ｜ MATHSCAPE`,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0b1020",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
