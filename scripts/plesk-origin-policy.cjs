"use strict";

// CDP interception pauses every network request, including each redirect hop,
// before Chromium connects. The caller creates a single isolated page and
// attaches this guard before navigating or entering any credentials.
async function restrictToPanelOrigin(page, panelOrigin) {
  const session = await page.context().newCDPSession(page);
  session.on("Fetch.requestPaused", async ({ requestId, request }) => {
    let allowed = false;
    try {
      const url = new URL(request.url);
      allowed = url.origin === panelOrigin && !url.username && !url.password;
    } catch { /* fail closed */ }
    try {
      if (allowed) await session.send("Fetch.continueRequest", { requestId });
      else await session.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    } catch { /* context or request already closed */ }
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return session;
}
module.exports = { restrictToPanelOrigin };
