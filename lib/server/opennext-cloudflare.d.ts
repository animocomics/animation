/**
 * Type declarations keep in-place Plesk builds repeatable after OpenNext is
 * pruned. Cloudflare builds still resolve and bundle the real npm package.
 */
declare module "@opennextjs/cloudflare" {
  export function getCloudflareContext(): { env: unknown };
  export function defineCloudflareConfig<T>(config: T): T;
}
