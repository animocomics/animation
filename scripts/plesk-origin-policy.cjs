"use strict";

// In the isolated Plesk browser, inspect redirect responses before allowing
// Chromium to follow them. Playwright's plain route.continue() alone is not
// sufficient: a redirect can bypass the next origin's route handler.
async function restrictToPanelOrigin(context, panelOrigin) {
  await context.route("**/*", async (route) => {
    try {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== panelOrigin || requestUrl.username || requestUrl.password) return await route.abort();
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (response.status() >= 300 && response.status() < 400 && location) {
        const next = new URL(location, requestUrl);
        if (next.origin !== panelOrigin || next.username || next.password) return await route.abort();
      }
      return await route.fulfill({ response });
    } catch {
      // A failed interception never falls back to the browser's direct route.
      return route.abort().catch(() => undefined);
    }
  });
}
module.exports = { restrictToPanelOrigin };
