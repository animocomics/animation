import type { NextConfig } from "next";

const cloudflareBuild = process.env.NOMREH_CLOUDFLARE === "1";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.e2b.app"],
  serverExternalPackages: cloudflareBuild ? [] : ["better-sqlite3", "pdfjs-dist", "@napi-rs/canvas"],
  poweredByHeader: false,
  experimental: {
    // Shared hosts can reject Next.js' default multi-process page-data build.
    cpus: 1,
    workerThreads: false,
  },
  ...(cloudflareBuild
    ? {
        turbopack: {
          resolveAlias: {
            "better-sqlite3": "./lib/server/cloudflare-native-stub.ts",
            "@napi-rs/canvas": "./lib/server/cloudflare-native-stub.ts",
            "pdfjs-dist/legacy/build/pdf.mjs": "./lib/server/cloudflare-native-stub.ts",
          },
        },
      }
    : {}),
};

export default nextConfig;
