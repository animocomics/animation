import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // All application reads are authenticated and dynamic; no filesystem cache is used.
  routePreloadingBehavior: "none",
});
