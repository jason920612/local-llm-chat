import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root to this project — a stray lockfile in a parent
  // folder otherwise makes Next guess the wrong root.
  outputFileTracingRoot: path.join(__dirname),
  // better-sqlite3 is a native module — keep it server-side and unbundled.
  serverExternalPackages: ["better-sqlite3", "pdf-parse"],
  // Allow larger payloads for image / document uploads through Server Actions
  // and route handlers (handled per-route; this is a sane global default).
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
};

export default nextConfig;
