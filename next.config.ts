import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.e2b.app"],
  serverExternalPackages: ["better-sqlite3", "pdfjs-dist", "@napi-rs/canvas"],
  poweredByHeader: false,
  experimental: {
    // Shared hosts can reject Next.js' default multi-process page-data build.
    cpus: 1,
    workerThreads: false,
    // Avoid a separate compiler process on shared hosts with legacy libc.
    webpackBuildWorker: false,
  },
};

export default nextConfig;
