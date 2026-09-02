import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // three.js の examples を Turbopack で束ねるための最低限。画像は使わないので next/image は不要。
  transpilePackages: ["three"],
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
  ],
};

export default nextConfig;
