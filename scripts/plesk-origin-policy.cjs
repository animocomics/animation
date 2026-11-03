"use strict";

// Used only by the isolated Plesk browser. The panel URL is normalized before
// this function is called; all non-panel origins are rejected, including ports.
async function restrictToPanelOrigin(context, panelOrigin) {
  await context.route("**/*", async (route) => {
    let origin = "";
    try { origin = new URL(route.request().url()).origin; } catch { /* reject malformed URLs */ }
    if (origin !== panelOrigin) return route.abort();
    return route.continue();
  });
}
module.exports = { restrictToPanelOrigin };
