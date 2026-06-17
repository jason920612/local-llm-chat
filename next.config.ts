import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project — a stray lockfile in a parent
  // folder otherwise makes Next guess the wrong root.
  outputFileTracingRoot: path.join(__dirname),
  // better-sqlite3 is a native module — keep it server-side and unbundled.
  serverExternalPackages: ["better-sqlite3", "pdf-parse"],
  // Hide the floating Next.js dev indicator (it overlapped the sidebar footer).
  devIndicators: false,
  // Allow accessing the dev server from other devices on the LAN (phones etc.)
  // without Next's cross-origin dev warning. Add your machine's LAN IP here.
  allowedDevOrigins: [
    "192.168.1.2",
    "192.168.0.2",
    "192.168.1.1",
    "127.0.0.1",
  ],
  // Allow larger payloads for image / document uploads through Server Actions
  // and route handlers (handled per-route; this is a sane global default).
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate",
          },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        source: "/c/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate",
          },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      canvas: false,
    };
    return config;
  },
};

export default nextConfig;
