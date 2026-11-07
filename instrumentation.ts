/**
 * Application startup.
 *
 * There is deliberately nothing to resume here. The launcher used to start a
 * V2Ray client at boot so the AI route survived a restart; that client is gone,
 * so a restart now only has to start the web server.
 */
export async function register() {
  /* No background route to restore: every provider request is direct. */
}
