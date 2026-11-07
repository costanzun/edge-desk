import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // A separate build dir lets the mocked e2e server run next to `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
