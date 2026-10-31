/**
 * Node/Plesk builds never use Cloudflare bindings. This alias keeps the
 * OpenNext build-time package out of the production runtime and repeat builds.
 */
export function getCloudflareContext(): { env: Record<string, unknown> } {
  throw new Error("Cloudflare bindings are not available in the Node/Plesk runtime.");
}
