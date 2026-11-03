"use strict";
// A private tunnel proxy makes the browser's certificate exception incapable of
// reaching a different origin, including via popups or uninstrumented targets.
const http = require("node:http");
const net = require("node:net");

async function startPanelProxy(panelOrigin) {
  const panel = new URL(panelOrigin);
  if (panel.protocol !== "https:" || !panel.port || panel.username || panel.password) throw new Error("Invalid panel origin");
  const sockets = new Set();
  const proxy = http.createServer((_request, response) => { response.writeHead(403); response.end(); });
  proxy.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("connect", (request, client, head) => {
    let target;
    try { target = new URL(`https://${request.url}`); } catch { client.destroy(); return; }
    if (target.hostname !== panel.hostname || target.port !== panel.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const hostname = panel.hostname.replace(/^\[|\]$/g, "");
    const upstream = net.connect(Number(panel.port), hostname);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  return {
    address: `http://127.0.0.1:${proxy.address().port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}
module.exports = { startPanelProxy };
