import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the tracing root to this project. Without it Next walks up looking for a
  // lockfile and can settle on a parent directory (a stray package-lock.json in
  // $HOME is enough), which makes it trace the wrong file set.
  outputFileTracingRoot: path.join(process.cwd()),
  // The generated PNGs are drawn entirely on <canvas>; no next/image remote loaders
  // are used anywhere, so the app builds and runs with zero network access.
  images: { unoptimized: false },
};

export default nextConfig;
